"""Lazy agent imports let skill discovery and API tests work without a Gemini key."""


class AgentBackend:
    async def plan(self, prompt, program, *, on_llm):
        from webagent.llm import observe_llm
        from webagent.planner import plan_from_chat

        with observe_llm(on_llm):
            return await plan_from_chat(prompt, program)

    async def record(self, url, *, on_event, stop):
        from webagent.recorder import record

        return await record(url, on_event=on_event, stop=stop)

    async def abstract(self, trace, *, on_llm):
        from webagent.abstract import abstract
        from webagent.llm import observe_llm

        with observe_llm(on_llm):
            return await abstract(trace)

    async def run(self, url, program, arguments, *, on_event, on_action, on_llm):
        from webagent.browser import launch
        from webagent.llm import observe_llm
        from webagent.run import run_program

        with observe_llm(on_llm):
            async with launch(headless=True) as browser:
                return await run_program(browser, url, program, variables=arguments,
                                         on_event=on_event, on_action=on_action)

    async def close(self):
        import sys

        if module := sys.modules.get("webagent.llm"):
            await module.client.aio.aclose()
            module.client.close()
