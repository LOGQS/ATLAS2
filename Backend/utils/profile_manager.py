import os
import json
import shutil
from pathlib import Path
from uuid import uuid4
from werkzeug.utils import secure_filename
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

DATA_DIR = Path(os.path.abspath(os.path.join(os.getcwd(), "data")))
PROFILES_FILE = DATA_DIR / "profiles.json"
KNOWLEDGE_BASE_DIR = DATA_DIR / "knowledge_bases"


def load_profiles():
    if PROFILES_FILE.exists():
        with open(PROFILES_FILE, "r", encoding="utf-8") as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                return []
    return []


def save_profiles(profiles):
    DATA_DIR.mkdir(exist_ok=True)
    with open(PROFILES_FILE, "w", encoding="utf-8") as f:
        json.dump(profiles, f, indent=2, ensure_ascii=False)


def create_profile(name: str):
    profiles = load_profiles()
    profile_id = f"prof-{uuid4().hex[:8]}"
    profile = {"id": profile_id, "name": name, "vectorize": False}
    profiles.append(profile)
    save_profiles(profiles)
    (KNOWLEDGE_BASE_DIR / profile_id).mkdir(parents=True, exist_ok=True)
    return profile


def update_profile(profile_id: str, name: str | None = None, vectorize: bool | None = None):
    profiles = load_profiles()
    updated = False
    for p in profiles:
        if p.get("id") == profile_id:
            if name is not None:
                p["name"] = name
            if vectorize is not None:
                p["vectorize"] = vectorize
            updated = True
            break
    if updated:
        save_profiles(profiles)
    return updated


def delete_profile(profile_id: str):
    profiles = load_profiles()
    profiles = [p for p in profiles if p.get("id") != profile_id]
    save_profiles(profiles)
    shutil.rmtree(KNOWLEDGE_BASE_DIR / profile_id, ignore_errors=True)


def list_files(profile_id: str):
    kb_dir = KNOWLEDGE_BASE_DIR / profile_id
    files = []
    if kb_dir.exists():
        for f in kb_dir.iterdir():
            if f.is_file():
                files.append(f.name)
    return files


def save_file(profile_id: str, file_storage):
    kb_dir = KNOWLEDGE_BASE_DIR / profile_id
    kb_dir.mkdir(parents=True, exist_ok=True)
    filename = secure_filename(file_storage.filename)
    path = kb_dir / filename
    file_storage.save(str(path))
    return filename


def delete_file(profile_id: str, filename: str):
    path = KNOWLEDGE_BASE_DIR / profile_id / filename
    if path.exists():
        path.unlink()


def get_knowledge(profile_id: str, query: str = ""):
    """Get knowledge as text content (for vectorized search or system messages)"""
    kb_dir = KNOWLEDGE_BASE_DIR / profile_id
    if not kb_dir.exists():
        return ""
    texts = []
    for f in kb_dir.iterdir():
        if f.is_file():
            try:
                texts.append(f.read_text(encoding="utf-8", errors="ignore"))
            except Exception:
                continue
    if not texts:
        return ""
    profiles = load_profiles()
    profile = next((p for p in profiles if p.get("id") == profile_id), None)
    if profile and profile.get("vectorize") and query:
        try:
            vectorizer = TfidfVectorizer()
            docs_tfidf = vectorizer.fit_transform(texts)
            query_vec = vectorizer.transform([query])
            sims = cosine_similarity(query_vec, docs_tfidf).flatten()
            if sims.size == 0:
                return ""
            top_indices = sims.argsort()[-3:][::-1]
            selected = [texts[i] for i in top_indices]
            return "\n".join(selected)
        except Exception:
            return "\n".join(texts)
    else:
        return "\n".join(texts)


def get_profile_file_paths(profile_id: str):
    """Get file paths for direct attachment (for non-vectorized knowledge base)"""
    kb_dir = KNOWLEDGE_BASE_DIR / profile_id
    if not kb_dir.exists():
        return []
    
    file_paths = []
    for f in kb_dir.iterdir():
        if f.is_file():
            file_paths.append(str(f))
    return file_paths


def should_attach_files_directly(profile_id: str):
    """Check if files should be attached directly (knowledge base enabled but vectorization disabled)"""
    profiles = load_profiles()
    profile = next((p for p in profiles if p.get("id") == profile_id), None)
    if not profile:
        return False
    
    # Check if profile has files
    kb_dir = KNOWLEDGE_BASE_DIR / profile_id
    has_files = kb_dir.exists() and any(f.is_file() for f in kb_dir.iterdir())
    
    # Attach directly if has files but vectorization is disabled
    return has_files and not profile.get("vectorize", False)
