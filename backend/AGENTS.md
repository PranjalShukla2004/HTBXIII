# Task: Complete Frontend–Backend Integration and Screenshot-Based UI Implementation

You are working on an existing semantic web automation agent project.

I will attach a screenshot showing the exact UI design I want for the website.

Your task is to thoroughly inspect the entire repository, understand how the existing frontend and backend work, implement the frontend based on the attached screenshot, and fully integrate the frontend with the existing backend.

**The primary goal is a fully connected, functional website that I can manually run and inspect.**

This is an implementation task. Make the necessary frontend and integration changes directly.

## CRITICAL RULES — READ BEFORE STARTING

### Rule 1: DO NOT CHANGE THE BACKEND

The backend is already implemented, and I do not want its functionality changed in any way.

You must NOT:

- Modify existing backend business logic.
- Rewrite or refactor backend services.
- Change Playwright execution behaviour.
- Modify the semantic similarity matching implementation.
- Change AI agent planning or execution.
- Modify recorded workflow storage or replay.
- Change existing REST API endpoints.
- Change WebSocket event formats or protocols.
- Modify backend request or response schemas.
- Change database or persistence logic.
- Introduce new backend functionality.
- Change backend configuration in ways that affect its existing behaviour.

**Treat the entire backend as READ-ONLY.**

You are allowed and expected to inspect all backend files to understand how everything works.

However, all implementation changes should be restricted to the frontend and its integration/configuration layer.

If the frontend expects data in a different format than the backend provides, adapt the frontend to the existing backend response.

Do NOT modify the backend to match the frontend.

If a desired frontend feature is genuinely unsupported by the existing backend, clearly identify the limitation instead of modifying backend functionality or fabricating data.

### Rule 2: DO NOT RUN FORMAL TESTS OR SAVE TEST RESULTS

I will manually test the application myself by starting both the frontend and backend servers and interacting with the actual website.

Therefore:

- Do not create new test files.
- Do not introduce testing frameworks.
- Do not add unit, integration, or end-to-end test suites.
- Do not run existing formal test suites.
- Do not generate test reports.
- Do not create test result folders.
- Do not save screenshots for testing purposes.
- Do not create persistent testing artifacts.
- Do not add unnecessary mock test infrastructure.

You MAY perform small, temporary sanity checks or dummy runs if they help you verify an implementation detail.

You may also perform lightweight static checks where useful.

However, these checks are optional and should not produce persistent test files, reports, or results.

Do not spend time building testing infrastructure.

**I will handle the actual application testing manually.**

### Rule 3: DO NOT REWRITE WORKING FUNCTIONALITY

Preserve existing working functionality throughout the project.

Reuse existing:

- Frontend components.
- Backend endpoints.
- WebSocket connections.
- API clients.
- Application state management.
- Browser automation integrations.
- Environment configuration.

Avoid unnecessary refactoring, large architectural rewrites, or unrelated improvements.

Make the smallest maintainable changes necessary to create the desired working website.

---

# PHASE 1: Thoroughly Inspect the Entire Codebase

Before modifying any code, inspect the repository to understand its structure and existing functionality.

## 1.1 Frontend Architecture

Review:

- Frontend framework and application entry points.
- Routing and navigation.
- Page layouts and component hierarchy.
- Styling system, themes, and design conventions.
- Existing reusable components.
- State management and data flow.
- API client implementations.
- WebSocket hooks and services.
- Forms and user input handling.
- Loading, success, and error states.
- Existing placeholder or mock data.
- Any partially completed frontend/backend integrations.

Understand how the frontend is currently structured before changing its appearance.

## 1.2 Backend Architecture — READ ONLY

Inspect the backend to understand:

- Server entry points.
- REST API routes.
- WebSocket endpoints.
- Request and response schemas.
- Authentication or session handling, if present.
- Agent planning and execution flow.
- Playwright browser automation.
- Recorded workflow execution.
- Semantic matching.
- LLM fallback.
- Job creation and status tracking.
- Real-time execution events.
- Results returned by the backend.
- Error reporting.

Do not modify these systems.

Your objective is to understand the backend's existing interface so the frontend can use it correctly.

## 1.3 Identify Integration Gaps

Trace the complete existing application workflow:

User Input
→ Frontend Request
→ Backend Endpoint
→ Agent Execution
→ Backend Response / WebSocket Event
→ Frontend State Update
→ Correct UI Component

Identify any missing connections.

Pay particular attention to:

- Frontend actions that do not call the backend.
- Incorrect endpoint paths.
- Mismatched request or response structures.
- Unhandled WebSocket events.
- Backend results that never appear in the frontend.
- Components displaying hardcoded values.
- Missing loading or error feedback.
- Incorrect state updates.
- Duplicated API or WebSocket logic.

Resolve integration problems through frontend changes only.

---

# PHASE 2: Implement the UI From the Attached Screenshot

The screenshot attached to this prompt is the primary visual reference.

Carefully analyse it before implementing the frontend.

Recreate the design as accurately as practical, including:

- Main page structure.
- Navigation and sidebar, if present.
- Component positioning.
- Page proportions.
- Typography and font hierarchy.
- Background colours.
- Borders and rounded corners.
- Card designs.
- Buttons and input fields.
- Icons and status indicators.
- Padding, margins, and spacing.
- Scroll behaviour.
- Responsive layout.

## UI Requirements

1. Follow the attached screenshot closely.
2. Build actual interactive components, not a static visual replica.
3. Use the existing frontend framework and styling conventions where possible.
4. Reuse existing components when appropriate.
5. Create new frontend components where necessary.
6. Preserve consistent styling throughout the application.
7. Ensure layout responsiveness.
8. Implement appropriate hover, loading, active, disabled, and error states.
9. Do not introduce unnecessary visual elements.
10. Do not display technical backend data where the screenshot indicates user-facing information should appear.

If the screenshot shows a component for which the backend already provides data, connect that component to the real backend data.

If the screenshot requires a component that does not exist, create it in the appropriate frontend directory.

If a detail is not visible in the screenshot, follow the existing application's design conventions.

**Prioritise both visual accuracy and functional integration.**

---

# PHASE 3: Connect the Frontend to the Existing Backend

This is the most important technical part of the task.

The frontend must communicate correctly with the existing backend without requiring any backend modifications.

## 3.1 REST API Integration

Inspect all relevant backend API endpoints and connect them to the corresponding frontend functionality.

Ensure that:

- User input is submitted to the correct endpoint.
- Requests use the correct HTTP methods.
- Request bodies match the backend's existing schemas.
- Responses are parsed correctly.
- Data is displayed in the appropriate components.
- Loading states appear during requests.
- Errors are handled gracefully.
- Failed requests provide useful feedback.
- Existing endpoint behaviour is preserved.

Use the project's existing API client or service architecture wherever possible.

Do not duplicate request logic unnecessarily.

If required, configure the frontend's development proxy or environment variables so the frontend can communicate with the backend correctly when both servers run locally.

Prefer relative API paths or an appropriate centralised API base URL.

Avoid hardcoded endpoint URLs spread throughout the application.

Do not change backend ports, API routes, or server configuration.

## 3.2 WebSocket Integration

Inspect the existing backend WebSocket implementation.

Understand:

- The WebSocket URL.
- How connections are established.
- What events the backend emits.
- The structure of each event.
- How execution IDs and website identifiers are represented.
- How progress and completion events work.
- How errors are reported.
- Whether reconnection or event history mechanisms already exist.

Connect the frontend to this existing implementation.

### Expected behaviour

When the backend emits an event:

1. The frontend receives it.
2. The frontend parses it using the existing event structure.
3. The event updates the correct application state.
4. The corresponding UI component updates immediately.
5. The user can see the new information without refreshing the page.

Support all relevant existing events, including agent activity, execution progress, website status, errors, and completion results.

Do not invent new WebSocket event types.

Do not modify the backend WebSocket protocol.

If required, implement frontend adapters to transform existing backend events into a frontend-friendly representation.

### WebSocket Reliability

Handle:

- Initial connection.
- Connection errors.
- Disconnections.
- Reconnection, where appropriate.
- Cleanup when components unmount.
- Multiple simultaneous website executions.
- Duplicate events.
- Events arriving from different jobs.

Reuse existing WebSocket services rather than creating unnecessary duplicate connections.

---

# PHASE 4: Integrate the Agent Workflow Into the UI

The frontend should expose the functionality already implemented by the backend.

## Expected User Journey

1. The user opens the website.
2. The user enters a natural-language request.
3. The frontend sends the request to the existing backend.
4. The backend executes its existing agent workflow.
5. The frontend receives progress through the existing API/WebSocket interface.
6. Agent activity is displayed in the correct UI components.
7. Website execution statuses update in real time.
8. Results returned by the backend appear in the frontend.
9. The user can inspect the outcome of the automation.

Do not change how the backend plans or performs these actions.

## Agent Activity Display

If the backend provides progress messages, observations, and activity events, render them in the relevant part of the frontend.

Present technical events in a user-friendly way when possible.

For example, an existing backend message such as:

```text
[step] [3] click replayed from cache
```

May be presented as:

```text
Replaying a recorded click action.
```

However, the displayed message must accurately represent the actual backend event.

Do not fabricate agent decisions, reasoning, observations, or results.

Preserve the ability to inspect raw technical messages where appropriate.

## Website Status Display

Use actual backend status information to display:

- Queued.
- Running.
- Completed.
- Failed.
- Other states already supported by the backend.

Ensure each website is tracked independently.

A failure on one website should not incorrectly update the status of another.

## Results and Recommendations

Inspect how the backend returns final results.

If the backend provides:

- Extracted products.
- Product prices.
- Product URLs.
- Recommendations.
- Execution results.
- Website-specific outcomes.
- Agent-generated responses.

Display them using the appropriate UI components.

If the screenshot contains a comparison interface, connect it to the results the backend actually provides.

Support side-by-side comparison of available results where the data makes this possible.

**Do not generate fabricated recommendations or hardcoded results.**

If the backend only returns execution statuses and logs, display that information accurately.

Do not modify the backend to add result-generation functionality.

Clearly identify any backend capabilities that would be required for features not currently supported.

---

# PHASE 5: Ensure Every Frontend Component Works Correctly

Inspect all relevant UI components and connect their interactions to real application behaviour.

This includes, where applicable:

- Submit buttons.
- Input fields.
- Forms.
- Navigation.
- Tabs.
- Dropdown menus.
- Expandable sections.
- Site selection.
- Execution controls.
- Status displays.
- Agent activity panels.
- Result cards.
- Comparison views.
- Error notifications.

Do not leave decorative buttons that appear functional but have no action, unless they are intentionally non-interactive elements in the design.

For each interactive element, determine:

1. What the user expects it to do.
2. Whether the backend already supports that action.
3. Which existing API or WebSocket mechanism should be used.
4. Which frontend state should change.
5. How the UI should respond to success or failure.

If the action is fully frontend-side, implement it locally.

If the action requires unsupported backend functionality, do not invent a fake implementation. Disable or clearly identify that limitation instead.

---

# PHASE 6: Preserve Backend Browser Automation

The backend's existing Playwright automation must remain unchanged.

Do not modify:

- Browser launch settings.
- Headless or headed configuration.
- Browser contexts.
- Browser tabs.
- Automation scripts.
- Semantic selectors.
- Recorded workflows.
- LLM fallback logic.
- Execution scheduling.
- Session management.

The frontend should integrate with the existing execution behaviour rather than changing it.

If browser activity is already exposed through backend events, display the relevant updates using the target UI.

Do not introduce new browser-control mechanisms.

---

# PHASE 7: Environment and Server Integration

I will run the frontend and backend myself.

Make sure the frontend can communicate with the backend when both development servers are started.

Review existing environment configuration and ensure that:

- API base URLs are configured correctly.
- WebSocket URLs are configured correctly.
- Frontend development proxies work where applicable.
- The correct backend port is used.
- HTTP and WebSocket protocols are handled appropriately.
- Existing backend environment variables are respected.
- No secrets are exposed in frontend code.
- Existing CORS behaviour is accounted for without modifying the backend.

If necessary, create or update frontend environment example files.

Do not overwrite real secrets or existing private environment configurations.

Do not change backend configuration.

---

# PHASE 8: Verification — NO FORMAL TESTING REQUIRED

I will manually verify the implementation.

Do not run formal tests or save testing results.

You may perform optional temporary checks if useful, but do not create persistent test artifacts.

Focus on ensuring the implementation is internally consistent through code inspection.

In particular, verify that:

- Frontend API calls match actual backend endpoints.
- Request payloads match backend schemas.
- WebSocket event handlers match actual backend event formats.
- The correct UI components receive the correct data.
- Frontend imports and dependencies are consistent.
- No obvious unused integrations or broken references remain.
- No backend files have been modified.

Do not claim that the full application has been tested end to end.

I will do that manually.

---

# PHASE 9: Final Deliverables

After completing the implementation, provide a concise summary.

## 1. Changes Made

List the main frontend files created or modified and explain their purpose.

## 2. Frontend–Backend Integration

Explain:

- Which API endpoints the frontend uses.
- How WebSocket connections work.
- How incoming data updates frontend components.
- How user actions reach the backend.
- How results are displayed.

## 3. UI Implementation

Explain how the attached screenshot was translated into functional frontend components.

Mention any aspects that could not be implemented because of limitations in the existing backend.

## 4. Backend Preservation

Explicitly confirm whether any backend files were modified.

The expected result is:

**No backend files modified. No backend behaviour changed.**

If you cannot implement something without backend changes, report the limitation rather than making those changes.

## 5. Running the Application

Provide the exact commands required to:

1. Start the backend server.
2. Start the frontend server.
3. Open the frontend website locally.

Use the actual commands and ports from the repository.

Do not invent commands.

## 6. Manual Verification Checklist

Provide a short checklist of the main application interactions I should manually verify.

Do not execute the checklist yourself.

---

# DEFINITION OF DONE

The task is complete when:

- [ ] The entire frontend and backend codebase has been inspected.
- [ ] The frontend closely follows the attached screenshot.
- [ ] Existing frontend components have been reused where appropriate.
- [ ] Frontend actions are connected to actual backend functionality.
- [ ] Existing REST endpoints are integrated correctly.
- [ ] Existing WebSocket events are integrated correctly.
- [ ] Agent execution progress updates the appropriate UI components.
- [ ] Website execution statuses update correctly.
- [ ] Available backend results are displayed correctly.
- [ ] The frontend can be configured to connect to the existing backend servers.
- [ ] No fake data is presented as real backend output.
- [ ] No backend functionality has been modified.
- [ ] No backend files have been changed.
- [ ] No formal tests or persistent test results have been created.
- [ ] Clear instructions are provided for manually running both servers.

# FINAL INSTRUCTION

**Your responsibility is to integrate the existing frontend and backend into one cohesive, functional website while accurately implementing the attached UI screenshot.**

The backend is already implemented and must remain completely unchanged.

Do not expand the scope into backend development, new agent features, or testing infrastructure.

Start by inspecting the entire repository and understanding the screenshot.

Then implement the necessary frontend and integration changes directly.

Do not stop after providing an analysis or plan.

Make the actual code changes, and finish by explaining/giving me commands on how I can run the website and manually verify the integration.
