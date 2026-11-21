"""BHOOMI-AI prototype API — replace in-memory data with PostgreSQL for production."""
from datetime import datetime
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="BHOOMI-AI API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

records = [{"id":"REC20260914-001", "owner":"Ramesh Kumar", "khasra":"123/2", "village":"Aurangabad", "district":"Palwal", "area":"2.50 Acres", "status":"Needs verification", "confidence":87, "updated_at":"2026-09-14T10:20:00"}]

class Review(BaseModel):
    owner: str
    khasra: str
    village: str
    district: str
    area: str

@app.get("/health")
def health(): return {"status":"ok", "service":"BHOOMI-AI API"}

@app.get("/api/dashboard")
def dashboard():
    return {"metrics":{"processed":128, "trusted":96, "needs_review":12, "avg_confidence":91}, "pipeline":[{"name":"Input","state":"complete"},{"name":"AI extract","state":"complete"},{"name":"Validate","state":"active"},{"name":"Human verify","state":"pending"},{"name":"Trusted record","state":"pending"}]}

@app.get("/api/records")
def list_records(): return records

@app.post("/api/documents")
async def upload_document(file: UploadFile = File(...)):
    if not file.filename: raise HTTPException(400, "A document is required")
    record = {"id":f"REC{datetime.now():%Y%m%d}-{len(records)+1:03}", "owner":"Ramesh Kumar", "khasra":"123/2", "village":"Aurangabad", "district":"Palwal", "area":"2.50 Acres", "status":"Needs verification", "confidence":87, "updated_at":datetime.now().isoformat(), "source":file.filename}
    records.insert(0, record)
    return {"record":record, "message":"Document processed; uncertain fields queued for verification."}

@app.put("/api/records/{record_id}/verify")
def verify_record(record_id: str, review: Review):
    for record in records:
        if record["id"] == record_id:
            record.update(review.model_dump(), status="Trusted", confidence=100, updated_at=datetime.now().isoformat())
            return {"record":record, "audit_event":"Verified by authorised officer"}
    raise HTTPException(404, "Record not found")
