# Infrastructure and integration decisions

## Current scope

Offscript is the working name; the owner has not chosen a final name. Current implementation work is limited to this repository. Cue integration belongs to a later phase.

The owner selected managed Supabase/PostgreSQL for the future account and product database on October 13, 2026. Include Auth, versioned migrations and tested RLS when adding persistence. Preserve ephemeral chat unless the owner explicitly changes the retention policy. Docker Desktop on the Mac and rootless Docker Engine/Compose on the Samsung are part of the infrastructure direction.

The Samsung hosts the lightweight gateway and existing CPU text model. Image generation belongs on separate GPU infrastructure. Keep Grafana and metric storage external; prefer a private Node Exporter scrape, or an outbound collector when private scraping is unavailable. Export host and service health without conversation content. [Node Exporter](https://prometheus.io/docs/guides/node-exporter/).

## Near-term image candidate

The owner selected [abenzerps/Qwen-Image-2.1-Uncensored-Quantized](https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-Quantized) as the future image-generation candidate. The inspected card revision is `7959e658915f52274897fb573ffeda49de8dc16b`.

The publisher recommends Q4_K_M GGUF (4.60 GB), with an INT8 text encoder (9.35 GB) and VAE (676 MB), using ComfyUI and the maintained ComfyUI-GGUF loader. Runtime memory also includes activations; select hardware through a measured load test. Encoder CPU offload belongs on the GPU host, whose RAM budget must cover it. Keep these weights and the image runtime off the Samsung.

The card declares the Qwen Research license. Verify full upstream terms, pinned checksums, loader compatibility and the selected workflow before production GPU deployment. No image weights or image service have been installed by this setup.

Use an authenticated GPU worker with allowlisted workflows, bounded job sizes, cancellation and short-lived result access. The Samsung should handle small job metadata and streamed status, with large image payloads served by the GPU infrastructure. Define output retention explicitly before adding this feature.

## Later Cue integration

[Cue](https://github.com/Mher-1902/Cue) is an Electron copilot with separate screen, microphone and meeting-audio inputs. Its integration will need capability-specific vision and speech-to-text services; the image-generation model does not supply those interfaces.

Before integration, review local secret storage, renderer/IPC permissions, explicit capture controls, transport authentication and license compatibility. Any persistent account, tenant, job or private media data must include the RLS and isolation requirements in `SECURITY.md`. No Cue code is changed in this phase.
