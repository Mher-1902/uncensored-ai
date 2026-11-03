//! Bounded SSE framing across arbitrary network and UTF-8 boundaries.
//! This module retains only the current frame and never logs its content.
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use std::{collections::VecDeque, pin::Pin};
use tokio_util::sync::CancellationToken;

use crate::BackendError;

pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, BackendError>> + Send>>;
const FRAME_LIMIT: usize = 1_048_576;

fn framing_error() -> BackendError {
    BackendError::new(502, "The model sent an invalid or oversized stream frame.")
}

pub struct SseReader {
    source: ByteStream,
    cancel: CancellationToken,
    pending: Vec<u8>,
    data: Vec<u8>,
    data_lines: usize,
    frames: VecDeque<String>,
    queued_bytes: usize,
    eof: bool,
}

impl SseReader {
    pub fn new(source: ByteStream, cancel: CancellationToken) -> Self {
        Self { source, cancel, pending: Vec::new(), data: Vec::new(), data_lines: 0, frames: VecDeque::new(), queued_bytes: 0, eof: false }
    }

    fn finish_frame(&mut self) -> Result<(), BackendError> {
        if self.data_lines != 0 {
            if self.frames.len() >= 4096 || self.queued_bytes.saturating_add(self.data.len()) > 2_097_152 {
                return Err(framing_error());
            }
            let frame = String::from_utf8(std::mem::take(&mut self.data)).map_err(|_| framing_error())?;
            self.queued_bytes += frame.len();
            self.frames.push_back(frame);
            self.data_lines = 0;
        }
        Ok(())
    }

    fn line(&mut self, mut line: &[u8]) -> Result<(), BackendError> {
        if line.len() > FRAME_LIMIT { return Err(framing_error()); }
        if line.last() == Some(&b'\r') { line = &line[..line.len() - 1]; }
        if line.is_empty() { return self.finish_frame(); }
        if let Some(mut payload) = line.strip_prefix(b"data:") {
            if payload.first() == Some(&b' ') { payload = &payload[1..]; }
            let separator = usize::from(self.data_lines != 0);
            if self.data.len().saturating_add(separator).saturating_add(payload.len()) > FRAME_LIMIT {
                return Err(framing_error());
            }
            if separator != 0 { self.data.push(b'\n'); }
            self.data.extend_from_slice(payload);
            self.data_lines += 1;
        }
        Ok(())
    }

    fn process_pending(&mut self) -> Result<(), BackendError> {
        let mut start = 0;
        while let Some(relative) = self.pending[start..].iter().position(|byte| *byte == b'\n') {
            let end = start + relative;
            // Own only the current line while mutating the parser's frame buffer.
            let line = self.pending[start..end].to_vec();
            self.line(&line)?;
            start = end + 1;
        }
        if start != 0 { self.pending.drain(..start); }
        if self.pending.len() > FRAME_LIMIT { return Err(framing_error()); }
        Ok(())
    }

    pub async fn next_event(&mut self) -> Result<Option<String>, BackendError> {
        loop {
            if self.cancel.is_cancelled() { return Err(BackendError::new(499, "Request cancelled.")); }
            if let Some(frame) = self.frames.pop_front() { self.queued_bytes -= frame.len(); return Ok(Some(frame)); }
            if self.eof { return Ok(None); }
            let next = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return Err(BackendError::new(499, "Request cancelled.")),
                next = self.source.next() => next,
            };
            match next {
                Some(Ok(bytes)) => {
                    // The transport is not trusted to deliver small chunks. Parse
                    // bounded slices so one packet cannot create an unbounded buffer.
                    for part in bytes.chunks(8192) {
                        self.pending.extend_from_slice(part);
                        self.process_pending()?;
                    }
                }
                Some(Err(_)) => return Err(BackendError::new(502, "The model connection ended before the response finished.")),
                None => {
                    self.eof = true;
                    if !self.pending.is_empty() {
                        let line = std::mem::take(&mut self.pending);
                        self.line(&line)?;
                    }
                    self.finish_frame()?;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;

    fn reader(chunks: Vec<Vec<u8>>, cancel: CancellationToken) -> SseReader {
        SseReader::new(Box::pin(stream::iter(chunks.into_iter().map(|b| Ok(Bytes::from(b))))), cancel)
    }

    #[tokio::test]
    async fn parses_utf8_at_every_byte_boundary_and_multiline_frames() {
        let text = ": ping\r\ndata: {\"content\":\"Հայ 😀\"}\r\n\r\ndata: one\ndata: two\n\ndata: [DONE]";
        let mut r = reader(text.as_bytes().iter().map(|b| vec![*b]).collect(), CancellationToken::new());
        assert_eq!(r.next_event().await.unwrap().as_deref(), Some("{\"content\":\"Հայ 😀\"}"));
        assert_eq!(r.next_event().await.unwrap().as_deref(), Some("one\ntwo"));
        assert_eq!(r.next_event().await.unwrap().as_deref(), Some("[DONE]"));
        assert_eq!(r.next_event().await.unwrap(), None);
    }

    #[tokio::test]
    async fn rejects_oversized_lines_frames_and_invalid_utf8() {
        for chunks in [
            vec![vec![b'x'; FRAME_LIMIT + 1]],
            vec![b"data: ".iter().copied().chain(vec![b'a'; FRAME_LIMIT / 2 + 1]).chain(b"\ndata: ".iter().copied()).chain(vec![b'b'; FRAME_LIMIT / 2]).chain(b"\n\n".iter().copied()).collect()],
            vec![vec![b'd', b'a', b't', b'a', b':', 0xff, b'\n', b'\n']],
        ] {
            let mut r = reader(chunks, CancellationToken::new());
            assert!(r.next_event().await.is_err());
        }
    }

    #[tokio::test]
    async fn stop_interrupts_an_idle_network_stream() {
        let cancel = CancellationToken::new();
        let mut r = SseReader::new(Box::pin(stream::pending()), cancel.clone());
        cancel.cancel();
        assert_eq!(r.next_event().await.unwrap_err().status, 499);
    }
}
