from typing import Annotated
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, StringConstraints, field_validator

SkillId = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$")]
ArgumentValue = Annotated[str, StringConstraints(max_length=4096)]
ChoiceName = Annotated[str, StringConstraints(pattern=r"^\w{1,64}$")]
Requirement = Annotated[str, StringConstraints(min_length=1, max_length=200)]


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


class RunConstraints(Command):
    """What the shopper asked for beyond the skill's inputs (mirrors webagent.schemas.Constraints)."""
    items: int = Field(default=1, ge=1, le=10)
    max_price: float | None = Field(default=None, gt=0, le=10_000_000)
    total_budget: float | None = Field(default=None, gt=0, le=10_000_000)
    currency: str | None = Field(default=None, max_length=16)
    requirements: list[Requirement] = Field(default_factory=list, max_length=8)


class RunRequest(TargetCommand):
    arguments: dict[str, ArgumentValue] = Field(default_factory=dict, max_length=50)
    # Product options the shopper already chose (from the chat or an earlier answer), e.g. {"size": "12"};
    # used when the shop asks for them.
    choices: dict[ChoiceName, ArgumentValue] = Field(default_factory=dict, max_length=20)
    constraints: RunConstraints | None = None


class SheetAppendRequest(Command):
    sheet_url: Annotated[str, StringConstraints(pattern=r"^https://docs\.google\.com/spreadsheets/d/[\w-]+.*$",
                                                max_length=2048)]
    rows: list[list[Annotated[str, StringConstraints(max_length=2048)]]] = Field(min_length=1, max_length=50)


class AnswerRequest(Command):
    value: str = Field(min_length=1, max_length=200)
    # The field being answered; rejected if the agent is asking about something else by now.
    field: str | None = Field(default=None, max_length=64)

    @field_validator("value")
    @classmethod
    def nonempty_value(cls, value):
        if not value.strip():
            raise ValueError("An answer is required")
        return value.strip()


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