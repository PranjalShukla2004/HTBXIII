import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from webagent.schemas import IntentProgram

SKILL_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$")


class SkillStore:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.intents = data_dir / "intents"

    def path(self, skill_id: str) -> Path:
        if not SKILL_NAME.fullmatch(skill_id):
            raise ValueError("Invalid skill ID")
        return self.intents / f"{skill_id}.json"

    def load(self, skill_id: str) -> IntentProgram:
        path = self.path(skill_id)
        if path.is_symlink():
            raise ValueError("Skill files must not be symlinks")
        return IntentProgram.model_validate_json(path.read_text())

    def _metadata(self) -> dict:
        try:
            return json.loads((self.data_dir / "skill_metadata.json").read_text())
        except (FileNotFoundError, ValueError):
            return {}

    def describe(self, skill_id: str, program: IntentProgram) -> dict:
        metadata = self._metadata().get(skill_id, {})
        path = self.path(skill_id)
        created = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat() if path.exists() else None
        return {"id": skill_id, "goal": program.goal,
                "name": metadata.get("name", skill_id.replace("_", " ").replace("-", " ").title()),
                "description": metadata.get("description", program.goal),
                "site": metadata.get("site"), "created_at": created,
                "arguments": {name: {"type": "string", "default": value}
                              for name, value in program.variables.items()},
                "steps": [step.model_dump(mode="json") for step in program.steps]}

    def list(self) -> tuple[list[dict], list[str]]:
        skills, invalid = [], []
        for path in sorted(self.intents.glob("*.json")):
            try:
                skills.append(self.describe(path.stem, self.load(path.stem)))
            except (ValueError, OSError):
                invalid.append(path.name)
        return skills, invalid

    def save(self, skill_id: str, program: IntentProgram, *, replace: bool = False):
        path = self.path(skill_id)
        self.atomic_json(path, program.model_dump(mode="json"), replace=replace)

    def update_metadata(self, skill_id: str, **changes):
        program = self.load(skill_id)
        metadata = self._metadata()
        metadata[skill_id] = {**metadata.get(skill_id, {}), **changes}
        self.atomic_json(self.data_dir / "skill_metadata.json", metadata)
        return self.describe(skill_id, program)

    def delete(self, skill_id: str):
        self.path(skill_id).unlink()
        metadata = self._metadata()
        metadata.pop(skill_id, None)
        self.atomic_json(self.data_dir / "skill_metadata.json", metadata)

    @staticmethod
    def atomic_json(path: Path, payload: dict, *, replace: bool = True):
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        try:
            with os.fdopen(descriptor, "w") as output:
                json.dump(payload, output, indent=2)
            if replace:
                os.replace(temporary, path)
            else:
                # Linking into place fails atomically if another writer created it.
                os.link(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
