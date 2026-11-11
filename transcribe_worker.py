# -*- coding: utf-8 -*-
"""
AuditPrompter — worker de transcrição 100% local (faster-whisper).

O áudio NÃO sai deste computador: o modelo Whisper roda na CPU local.
(Somente o download do modelo, na primeira execução, usa a internet.)

Protocolo: uma linha JSON por comando no stdin, uma linha JSON por resposta no stdout.
  {"cmd": "warmup"}                                   -> {"loaded": true, "model": "..."}
  {"id": "x", "path": "a.webm", "prompt": "..."}      -> {"id": "x", "done": true, "text": "..."}
  {"id": "x", "path": "a.mp4", "stream": true}        -> {"id": "x", "segment": {...}, "duration": 123.4} ...
                                                          {"id": "x", "done": true, "text": "..."}
Erros: {"id": "x", "error": "mensagem"}
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")

MODEL_NAME = os.environ.get("AUDITPROMPTER_WHISPER_MODEL", "small")
DEVICE = os.environ.get("AUDITPROMPTER_WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("AUDITPROMPTER_WHISPER_COMPUTE", "int8")

# Frases que o Whisper costuma "alucinar" em trechos de silêncio ou ruído.
HALLUCINATIONS = (
    "legendas pela comunidade",
    "amara.org",
    "obrigado por assistir",
    "obrigada por assistir",
    "inscreva-se no canal",
    "se inscreva no canal",
    "legendado por",
    "transcrição e legendas",
)

_model = None


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)
    return _model


def keep_segment(seg):
    text = (seg.text or "").strip()
    if len(text) < 2:
        return False
    low = text.lower()
    if any(h in low for h in HALLUCINATIONS):
        return False
    if getattr(seg, "no_speech_prob", 0.0) > 0.75 and getattr(seg, "avg_logprob", 0.0) < -0.8:
        return False
    return True


def handle(job):
    jid = job.get("id")
    path = job.get("path")
    streaming = bool(job.get("stream"))
    model = get_model()
    segments, info = model.transcribe(
        path,
        language="pt",
        task="transcribe",
        beam_size=5 if streaming else 2,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=streaming,
        initial_prompt=(job.get("prompt") or None),
        temperature=0.0,
    )
    parts = []
    for seg in segments:
        if not keep_segment(seg):
            continue
        text = seg.text.strip()
        parts.append(text)
        if streaming:
            emit(
                {
                    "id": jid,
                    "segment": {"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text},
                    "duration": round(getattr(info, "duration", 0.0) or 0.0, 2),
                }
            )
    emit({"id": jid, "done": True, "text": " ".join(parts).strip()})


def main():
    emit({"ready": True, "model": MODEL_NAME})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = {}
        try:
            job = json.loads(line)
            if job.get("cmd") == "warmup":
                get_model()
                emit({"loaded": True, "model": MODEL_NAME})
                continue
            handle(job)
        except Exception as exc:  # noqa: BLE001 - devolve o erro ao servidor em vez de derrubar o worker
            emit({"id": job.get("id"), "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
