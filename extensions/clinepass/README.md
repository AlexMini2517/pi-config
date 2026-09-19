# pi-clinepass-provider

ClinePass provider extension for [pi](https://github.com/earendil-works/pi).

Integrates Cline's [ClinePass](https://docs.cline.bot/getting-started/clinepass) subscription as a native provider in pi, giving access to curated open-weight coding models (GLM-5.2, Kimi K2.7, DeepSeek V4, and more) through Cline's OpenAI-compatible API with elevated rate limits.

## Setup

1. Subscribe at [app.cline.bot](https://app.cline.bot) and generate an API key (`Settings` → `API Keys`).
2. Provide your credentials using one of the following methods:
   - **Environment variable**: Set `CLINE_API_KEY="your_api_key"`
   - **Cline CLI auth reuse**: Sign in via `cline auth` in terminal; the extension will automatically detect credentials in `~/.cline/data/settings/providers.json`
   - **Interactive login**: Run `/login` in pi and select `ClinePass`
3. Switch models in pi with `/model` and select any available ClinePass model.

## Features

- **Dynamic Model Discovery**: Fetches active models directly from Cline's API endpoint on startup, with static fallbacks.
- **Dual Authentication**: Works seamlessly with static API keys or short-lived WorkOS OAuth tokens with auto-refresh.
- **CLI Header Spoofing**: Matches Cline CLI request headers to ensure compatibility and access to subscription endpoints.
- **Prompt Role Compatibility**: Automatically maps roles to ensure reasoning models without `developer` role support execute cleanly.

## Installation

Copy the `clinepass` directory into your pi extensions:

```bash
cp -r extensions/clinepass ~/.pi/agent/extensions/
```

Then restart pi or run `/reload`.
