import asyncio, sys
from .browser import launch
from .config import DATA
from .llm import stats
from .orchestrator import shop_and_log
from .planner import plan_from_chat
from .schemas import IntentProgram, AgentEvent
from .run import cli_ask

# uv run python -m webagent.chat <skill_name> "<message>"
async def _main():
    name, message = sys.argv[1], sys.argv[2]
    program = IntentProgram.model_validate_json((DATA / "intents" / f"{name}.json").read_text())

    plan = await plan_from_chat(message, program)
    print(f"PLAN: {plan.summary}\n  inputs: {plan.variables}\n  sites:  {plan.sites}\n  sheet:  {plan.sheet_url}\n")
    if plan.choices:
        print(f"  choices: {plan.choices}")
        
    def show(ev: AgentEvent):
        site = f"{ev.site} " if ev.site else ""
        print(f"[{ev.kind:6}] {site}{ev.message}")

    async with launch() as ctx:
                results = await shop_and_log(ctx, program, plan, on_event=show, ask=cli_ask)
    ok = sum(r.status == "done" for r in results)
    print(f"\n{ok}/{len(results)} sites added to cart   LLM calls: {stats['calls']}")

if __name__ == "__main__":
    asyncio.run(_main())