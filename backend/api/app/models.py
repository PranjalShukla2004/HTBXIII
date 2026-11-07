from typing import Annotated
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, StringConstraints, field_validator

SkillId = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$")]
ArgumentValue = Annotated[str, StringConstraints(max_length=4096)]


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TargetCommand(Command):
    url: HttpUrl

    @field_validator("url", mode="before")
    @classmethod
    def normalize_url(cls, value):
        if isinstance(value, str):
            value = value.strip()
            if "://" not in value:
                value = "https://" + value
            parsed = urlsplit(value)
            if parsed.username is not None or parsed.password is not None:
                raise ValueError("URLs must not include credentials")
        return value


class RunRequest(TargetCommand):
    arguments: dict[str, ArgumentValue] = Field(default_factory=dict, max_length=50)


class RecordingRequest(TargetCommand):
    skill_id: SkillId
    replace: bool = False


class PlanRequest(Command):
    prompt: str = Field(min_length=1, max_length=12000)


class SkillUpdate(Command):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(max_length=4000)

    @field_validator("name")
    @classmethod
    def nonempty_name(cls, value):
        if not value.strip():
            raise ValueError("A skill name is required")
        return value.strip()
