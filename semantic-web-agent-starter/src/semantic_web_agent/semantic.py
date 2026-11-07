"""Pure local semantic matching; never asks a hosted LLM for a decision."""
from __future__ import annotations

import difflib
from typing import Any


_ACTION_COMPAT = {
    "fill": {"fill"},
    "click": {"click"},
    "check": {"check"},
    "uncheck": {"check"},
    "select_option": {"select_option"},
}


class SemanticMatcher:
    def __init__(self, model_name: str = "sentence-transformers/all-MiniLM-L6-v2"):
        from sentence_transformers import SentenceTransformer
        self.model = SentenceTransformer(model_name)

    def rank(self, step: dict[str, Any], elements: list[dict], used_ids: set[str] | None = None):
        used_ids = used_ids or set()
        viable = [
            el for el in elements
            if el["id"] not in used_ids
            and el["action"] in _ACTION_COMPAT.get(step["action"], set())
        ]
        if not viable:
            return []

        query = step["target"]["label"]
        # The label is the primary semantic signal; role/action compatibility is
        # enforced separately, so input and button texts are never pooled together.
        documents = [" ".join([el["label"], el["placeholder"], el["context"]]).strip()
                     for el in viable]
        vectors = self.model.encode([query, *documents], normalize_embeddings=True)
        semantic_scores = vectors[1:] @ vectors[0]
        ranked = []
        for el, document, semantic_score in zip(viable, documents, semantic_scores):
            exact_bonus = 1.0 if query.casefold().strip() == el["label"].casefold().strip() else 0.0
            lexical_score = difflib.SequenceMatcher(
                None, query.casefold(), document.casefold()
            ).ratio()
            score = 0.8 * float(semantic_score) + 0.15 * lexical_score + 0.05 * exact_bonus
            ranked.append((score, el))
        return sorted(ranked, key=lambda item: item[0], reverse=True)
