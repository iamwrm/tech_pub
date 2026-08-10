# Recommended first test on GCP L4

Use this setup:

* **VM:** `g2-standard-8`
* **GPU:** 1× NVIDIA L4, 24 GB VRAM
* **CPU/RAM:** 8 vCPU, 32 GB RAM
* **OS:** Ubuntu 22.04 LTS
* **Disk:** 100 GB `pd-balanced`
* **Model:** `Qwen/Qwen3-ASR-1.7B`
* **Interface:** Gradio in your Windows browser
* **Connection:** SSH port forwarding; do **not** expose port 8000 publicly

`g2-standard-4` also has one 24 GB L4, but only 16 GB system memory. `g2-standard-8` gives more comfortable headroom for model loading, audio processing, and a later move to vLLM. Tokyo’s `asia-northeast1` region offers G2 machines in zones `a`, `b`, and `c`, subject to quota and capacity. ([Google Cloud Documentation][1])

## 1. Create the VM

Run this from **Google Cloud Shell**:

```bash
PROJECT_ID="your-gcp-project-id"
ZONE="asia-northeast1-a"
VM="qwen-asr-l4"

gcloud config set project "$PROJECT_ID"

gcloud compute instances create "$VM" \
  --zone="$ZONE" \
  --machine-type=g2-standard-8 \
  --image-family=ubuntu-2204-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=100GB \
  --boot-disk-type=pd-balanced \
  --maintenance-policy=TERMINATE \
  --restart-on-failure \
  --no-shielded-secure-boot
```

You do not need a separate `--accelerator` argument: the L4 is part of the G2 machine type.

G2 machines currently cannot use Deep Learning VM images as boot disks, so an ordinary Ubuntu image plus Google’s GPU driver installer is the simplest route. G2 also does not support `pd-standard`, which is why the command uses `pd-balanced`. ([Google Cloud Documentation][2])

If zone `asia-northeast1-a` reports insufficient capacity, change only:

```bash
ZONE="asia-northeast1-b"
```

or:

```bash
ZONE="asia-northeast1-c"
```

A quota error is different from a capacity error: in that case, request additional NVIDIA L4/G2 GPU quota in the GCP console. ([Google Cloud Documentation][3])

## 2. Install the NVIDIA driver

Connect from Cloud Shell:

```bash
gcloud compute ssh "$VM" --zone="$ZONE"
```

Inside the VM:

```bash
sudo apt-get update

sudo apt-get install -y \
  curl \
  python3-venv \
  python3-pip \
  build-essential \
  ffmpeg \
  sox \
  libsox-fmt-all
```

Install the GPU driver using Google’s installer:

```bash
curl -L \
  https://storage.googleapis.com/compute-gpu-installation-us/installer/latest/cuda_installer.pyz \
  --output cuda_installer.pyz

sudo python3 cuda_installer.pyz install_driver \
  --installation-mode=repo \
  --installation-branch=lts
```

The installer may reboot or disconnect the SSH session. After reconnecting, verify the GPU:

```bash
nvidia-smi
```

You should see an **NVIDIA L4** with approximately **24 GB** of GPU memory. Google documents this installer for supported Ubuntu GPU VMs and notes that a reboot or rerun can be required during installation. ([Google Cloud Documentation][4])

## 3. Install Qwen3-ASR

Create a separate Python environment:

```bash
python3 -m venv ~/venvs/qwen-asr
source ~/venvs/qwen-asr/bin/activate

python -m pip install --upgrade pip setuptools wheel
pip install --upgrade qwen-asr
```

Verify that PyTorch sees the L4:

```bash
python - <<'PY'
import torch

print("PyTorch version:", torch.__version__)
print("PyTorch CUDA:", torch.version.cuda)
print("CUDA available:", torch.cuda.is_available())

if torch.cuda.is_available():
    print("GPU:", torch.cuda.get_device_name(0))
    total_gb = torch.cuda.get_device_properties(0).total_memory / 1024**3
    print(f"GPU memory: {total_gb:.1f} GB")
PY
```

Expected key lines:

```text
CUDA available: True
GPU: NVIDIA L4
GPU memory: approximately 22–24 GB
```

The official Qwen package supports a Transformers backend through the regular `qwen-asr` installation. The separate `[vllm]` installation is only necessary when you move to the streaming/vLLM server. ([GitHub][5])

## 4. Connect securely from Windows

Install the Google Cloud CLI on your Windows desktop if it is not already installed, then open **PowerShell**:

```powershell
gcloud auth login
gcloud config set project YOUR_GCP_PROJECT_ID
```

Start an SSH session with local port forwarding:

```powershell
gcloud compute ssh qwen-asr-l4 `
  --zone=asia-northeast1-a `
  --ssh-flag="-L 8000:127.0.0.1:8000"
```

Adjust the zone if you created the VM in `b` or `c`.

Keep this PowerShell window open. The forwarding means:

```text
Windows browser localhost:8000
             ↓ encrypted SSH
Cloud VM localhost:8000
```

There is **no need to create a GCP firewall rule for port 8000**. This is preferable to exposing an unauthenticated Gradio interface on the public internet. It also lets the browser treat the application as localhost, avoiding the HTTPS requirement that normally affects microphone capture on a remote web page. Google Cloud CLI supports passing standard SSH port-forwarding flags in this form. ([Google Cloud Documentation][6])

## 5. Run the stock Qwen browser demo

Inside the SSH session opened from Windows:

```bash
source ~/venvs/qwen-asr/bin/activate

qwen-asr-demo \
  --asr-checkpoint Qwen/Qwen3-ASR-1.7B \
  --backend transformers \
  --cuda-visible-devices 0 \
  --ip 127.0.0.1 \
  --port 8000
```

The first launch downloads the model into the VM’s Hugging Face cache. Watch the terminal; once Gradio prints the local address, open this on Windows:

```text
http://127.0.0.1:8000
```

Allow microphone access in the browser. Chrome or Edge should both work.

In the page:

* Leave **Language** on automatic detection.
* Record or upload a short clip.
* Initially leave timestamps disabled.
* Transcribe Mandarin, English, and mixed-language clips separately.

This is Qwen’s official Gradio demo command, with the host changed from `0.0.0.0` to `127.0.0.1` because access is going through the SSH tunnel. ([GitHub][5])

## Important limitation: the stock demo does not test vocabulary prompting

The built-in Gradio page exposes audio, language selection, timestamp selection, and transcription, but it currently does **not** expose Qwen’s `context` parameter. Therefore, it is useful for confirming:

* The L4 and CUDA installation work.
* Microphone capture works.
* Baseline Chinese–English recognition quality.
* Basic latency.

It is **not yet a fair test of your technical terminology use case**. The underlying Qwen ASR interface supports a context string, but the stock Gradio callback does not pass one. 

After the stock page works, stop it with:

```text
Ctrl+C
```

Then run the context-enabled page below.

# Context-enabled browser demo

Create the application on the VM:

```bash
cat > ~/qwen_context_demo.py <<'PY'
from __future__ import annotations

import numpy as np
import torch
import gradio as gr
from qwen_asr import Qwen3ASRModel


MODEL_ID = "Qwen/Qwen3-ASR-1.7B"

print(f"Loading {MODEL_ID}...")

model = Qwen3ASRModel.from_pretrained(
    MODEL_ID,
    dtype=torch.bfloat16,
    device_map="cuda:0",
    max_inference_batch_size=1,
    max_new_tokens=1024,
)


def prepare_audio(audio: tuple[int, np.ndarray] | None) -> tuple[np.ndarray, int]:
    if audio is None:
        raise gr.Error("Record or upload audio first.")

    sample_rate, waveform = audio
    waveform = np.asarray(waveform)

    if waveform.size == 0:
        raise gr.Error("The supplied audio is empty.")

    # Convert stereo/multichannel audio to mono.
    if waveform.ndim > 1:
        waveform = waveform.mean(axis=-1)

    # Gradio may return integer PCM or floating-point samples.
    if np.issubdtype(waveform.dtype, np.integer):
        dtype_info = np.iinfo(waveform.dtype)
        scale = max(abs(dtype_info.min), dtype_info.max)
        waveform = waveform.astype(np.float32) / float(scale)
    else:
        waveform = waveform.astype(np.float32)

        peak = float(np.max(np.abs(waveform)))
        if peak > 1.0:
            waveform = waveform / peak

    waveform = np.clip(waveform, -1.0, 1.0)
    return waveform, int(sample_rate)


def transcribe(
    audio: tuple[int, np.ndarray] | None,
    context: str,
) -> tuple[str, str]:
    waveform, sample_rate = prepare_audio(audio)

    try:
        results = model.transcribe(
            audio=(waveform, sample_rate),
            language=None,  # Automatic detection for Chinese/English mixing.
            context=(context or "").strip(),
            return_time_stamps=False,
        )
    except Exception as exc:
        raise gr.Error(f"Transcription failed: {exc}") from exc

    if not results:
        raise gr.Error("The model returned no transcription.")

    result = results[0]
    return result.language or "auto", result.text or ""


DEFAULT_CONTEXT = """The speaker may mix Mandarin Chinese and English.

Preserve the following technical terms and capitalization:
Qwen3-ASR, Google Cloud, GCP, NVIDIA L4, CUDA, cuDNN,
TensorRT, TensorRT-LLM, vLLM, PyTorch, Hugging Face,
Kubernetes, K8s, kube-apiserver, gRPC, PostgreSQL,
ClickHouse, LangGraph, RAG, retrieval-augmented generation,
向量数据库, 检索增强生成, 大语言模型, 多模态, 混合精度.
"""


with gr.Blocks(title="Qwen3-ASR Technical Vocabulary Test") as demo:
    gr.Markdown(
        """
        # Qwen3-ASR 1.7B

        Mandarin–English mixed transcription with technical vocabulary context.
        """
    )

    audio_input = gr.Audio(
        sources=["microphone", "upload"],
        type="numpy",
        label="Record or upload audio",
    )

    context_input = gr.Textbox(
        value=DEFAULT_CONTEXT,
        label="Context and technical vocabulary",
        lines=8,
    )

    transcribe_button = gr.Button("Transcribe", variant="primary")

    detected_language = gr.Textbox(
        label="Detected language",
        interactive=False,
    )

    transcript = gr.Textbox(
        label="Transcript",
        lines=12,
        interactive=False,
    )

    transcribe_button.click(
        fn=transcribe,
        inputs=[audio_input, context_input],
        outputs=[detected_language, transcript],
    )


demo.queue(default_concurrency_limit=1).launch(
    server_name="127.0.0.1",
    server_port=8000,
)
PY
```

Run it:

```bash
source ~/venvs/qwen-asr/bin/activate
python ~/qwen_context_demo.py
```

Then reopen or refresh:

```text
http://127.0.0.1:8000
```

The custom page calls the supported `context=` interface and leaves language selection automatic, making it more representative of your actual Chinese–English technical dictation workload. 

## A useful first test

Record this naturally rather than reading unusually slowly:

> 我们准备把 Qwen3-ASR 部署在 Google Cloud 的 NVIDIA L4 上，然后用 vLLM 提供 API。后端会连接 PostgreSQL 和 ClickHouse，GPU inference 使用 CUDA 和 TensorRT-LLM。

Then try an English-dominant version:

> We deployed Qwen3-ASR on an NVIDIA L4，然后用 Kubernetes 管理服务。The kube-apiserver sends metadata to PostgreSQL, and the inference layer uses CUDA and TensorRT-LLM.

Run each recording twice:

1. With the context box empty.
2. With the vocabulary context included.

Compare:

| Measurement           | What to record                                      |
| --------------------- | --------------------------------------------------- |
| Technical-term recall | Correctly transcribed terms ÷ spoken terms          |
| Exact spelling        | `vLLM`, `cuDNN`, `TensorRT-LLM`, `kube-apiserver`   |
| Code switching        | Whether Chinese and English are preserved correctly |
| Punctuation           | Whether sentence boundaries are sensible            |
| Latency               | Time from clicking Transcribe until text appears    |

For this use case, technical-term recall is more meaningful than ordinary word-error rate alone.

## Monitor the GPU

In a second SSH session, run:

```bash
watch -n 1 nvidia-smi
```

During transcription, you should see Python consuming GPU memory and GPU utilization increasing.

To see the model cache size:

```bash
du -sh ~/.cache/huggingface
```

## Stop the VM after testing

From Cloud Shell or Windows PowerShell:

```bash
gcloud compute instances stop qwen-asr-l4 \
  --zone=asia-northeast1-a
```

Use the actual zone if you selected `b` or `c`. Stopping preserves the boot disk and downloaded model cache while stopping the VM’s active compute usage. ([Google Cloud Documentation][7])

[1]: https://docs.cloud.google.com/compute/docs/gpus "GPU machine types  |  Compute Engine  |  Google Cloud Documentation"
[2]: https://docs.cloud.google.com/compute/docs/gpus/create-vm-with-gpus "Overview of creating an instance with attached GPUs  |  Compute Engine  |  Google Cloud Documentation"
[3]: https://docs.cloud.google.com/compute/docs/regions-zones/gpu-regions-zones "GPU locations  |  Compute Engine  |  Google Cloud Documentation"
[4]: https://docs.cloud.google.com/compute/docs/gpus/install-drivers-gpu "Install GPU drivers  |  Compute Engine  |  Google Cloud Documentation"
[5]: https://github.com/QwenLM/Qwen3-ASR "GitHub - QwenLM/Qwen3-ASR: Qwen3-ASR is an open-source series of ASR models developed by the Qwen team at Alibaba Cloud, supporting stable multilingual speech/music/song recognition, language detection and timestamp prediction. · GitHub"
[6]: https://docs.cloud.google.com/sdk/gcloud/reference/compute/ssh?utm_source=chatgpt.com "gcloud compute ssh | Google Cloud SDK"
[7]: https://docs.cloud.google.com/sdk/gcloud/reference/compute/instances/stop?utm_source=chatgpt.com "gcloud compute instances stop | Google Cloud SDK"
