"""Run one local API worker; app initialization handles the agent source path."""

import uvicorn

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, workers=1)
