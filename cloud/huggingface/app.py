"""Deployment candidate; requires real ZeroGPU validation before production use."""
import os
os.environ["GRADIO_ANALYTICS_ENABLED"] = "False"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
from queue import Empty
from threading import Event, Thread
import gradio as gr
import spaces
import torch
from transformers import AutoModelForImageTextToText, AutoTokenizer, TextIteratorStreamer, StoppingCriteria, StoppingCriteriaList
from validation import validate

MODEL = "nemozxy123/Huihui-Qwen3.5-9B-abliterated-AWQ-4bit"
REVISION = "15f9e35cfccf7106b611866eadc01bf37d3ec325"
# ZeroGPU requires root-level CUDA placement, before entering the GPU function.
# No trust_remote_code; model architecture comes from the pinned Transformers package.
tokenizer = AutoTokenizer.from_pretrained(MODEL, revision=REVISION)
model = AutoModelForImageTextToText.from_pretrained(
    MODEL, revision=REVISION, dtype=torch.bfloat16,
    device_map="cuda", low_cpu_mem_usage=True,
)
model.eval()
SYSTEM = "You are Offscript, a helpful assistant. Answer directly and accurately. Be concise unless asked for detail. Acknowledge uncertainty. You have no live internet access."

class StopWhenCancelled(StoppingCriteria):
    def __init__(self, event): self.event = event
    def __call__(self, input_ids, scores, **kwargs): return self.event.is_set()

def generate(messages, max_tokens):
    # Reject invalid/oversized history before requesting the shared GPU quota.
    try:
        history, max_tokens = validate(messages, max_tokens)
    except ValueError as error:
        raise gr.Error(str(error)) from None
    yield from generate_on_gpu(history, max_tokens)

@spaces.GPU(duration=60)
def generate_on_gpu(history, max_tokens):
    inputs = tokenizer.apply_chat_template(
        [{"role": "system", "content": SYSTEM}] + history,
        tokenize=True, return_dict=True, return_tensors="pt",
        add_generation_prompt=True, enable_thinking=False,
    ).to("cuda")
    # Explicit capacity error instead of silently discarding prior turns.
    if inputs["input_ids"].shape[-1] + max_tokens > 16384:
        raise gr.Error("This conversation exceeds the model's configured context. Clear it or shorten your question.")
    cancelled = Event()
    streamer = TextIteratorStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True, timeout=2)
    errors = []
    def worker():
        try:
            with torch.inference_mode():
                model.generate(**inputs, max_new_tokens=max_tokens, do_sample=True,
                    temperature=0.7, top_p=0.8, use_cache=True, streamer=streamer,
                    stopping_criteria=StoppingCriteriaList([StopWhenCancelled(cancelled)]))
        except Exception:
            errors.append(True)
            streamer.end()
    thread = Thread(target=worker, daemon=True)
    thread.start()
    answer = ""
    try:
        while True:
            try:
                text = next(streamer)
            except Empty:
                if not thread.is_alive(): break
                continue
            except StopIteration:
                break
            answer += text
            yield answer
        if errors or not answer.strip():
            raise gr.Error("The cloud model could not complete a reply. Please try again.")
    finally:
        cancelled.set()
        thread.join(timeout=5)
        history.clear()
        inputs = None
        answer = ""

with gr.Blocks(analytics_enabled=False, delete_cache=(60, 60)) as demo:
    gr.Markdown("# Offscript cloud model\nTemporary inference API. No application chat archive. Free GPU quotas apply.")
    messages = gr.JSON(label="Messages")
    max_tokens = gr.Dropdown([256, 512, 1024], value=512, label="Reply tokens")
    output = gr.Textbox(label="Reply", lines=12)
    run = gr.Button("Generate")
    event = run.click(generate, [messages, max_tokens], output, api_name="generate", concurrency_limit=1)
    gr.Button("Stop").click(fn=None, cancels=[event])
# This schedules GPU work; it does not impose a 10-user business limit.
# A persistent vLLM service belongs on a dedicated GPU host, not ZeroGPU.
demo.queue(default_concurrency_limit=1)
demo.launch(show_error=False, enable_monitoring=False, state_session_capacity=100)
