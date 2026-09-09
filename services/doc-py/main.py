"""The polyglot arm. Deliberately trivial: its job is to prove that a Python service in the same
repo deploys, and that the TypeScript service can reach it INTERNALLY on both platforms."""
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()


class Doc(BaseModel):
    text: str


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/analyze")
def analyze(doc: Doc) -> dict:
    words = doc.text.split()
    return {
        "words": len(words),
        "chars": len(doc.text),
        "longest": max(words, key=len) if words else None,
    }
