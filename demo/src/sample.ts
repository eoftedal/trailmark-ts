/** A tiny polyglot project for trying the explorer without picking a folder. */

export const SAMPLE_ROOT = "sample-app";

export const SAMPLE_FILES: Record<string, string> = {
  "pyproject.toml": `[project]
name = "sample-app"

[project.scripts]
sample = "app.cli:main"
`,
  "app/__init__.py": "",
  "app/auth.py": `class Auth:
    """Verifies session tokens."""

    def verify(self, token: str) -> bool:
        if not token:
            raise PermissionError("missing token")
        return self._check_sig(token)

    def _check_sig(self, token: str) -> bool:
        parts = token.split(".")
        if len(parts) != 3:
            return False
        for part in parts:
            if not part or part.startswith("-"):
                return False
        return hmac_compare(parts[2], sign(parts[0], parts[1]))
`,
  "app/web.py": `from flask import Flask, request

from app.auth import Auth
from app.store import load_user, save_profile

app = Flask(__name__)


@app.route("/profile", methods=["POST"])
def update_profile():
    auth = Auth()
    if not auth.verify(request.headers.get("Authorization")):
        return deny()
    user = load_user(request.json["id"])
    return save_profile(user, request.json)


def deny():
    return {"error": "forbidden"}, 403
`,
  "app/store.py": `def load_user(user_id: int):
    return query("SELECT * FROM users WHERE id = %s", user_id)


def save_profile(user, data: dict):
    if user is None or "name" not in data:
        raise ValueError("bad profile")
    return query("UPDATE users SET name = %s", data["name"])
`,
  "app/cli.py": `from app.store import load_user


def main():
    print(load_user(1))
`,
  "web/client.ts": `export async function updateProfile(id: number, name: string): Promise<Response> {
  const body = JSON.stringify({ id, name });
  return post("/profile", body);
}

async function post(url: string, body: string): Promise<Response> {
  if (!url.startsWith("/")) throw new Error("relative urls only");
  return fetch(url, { method: "POST", body });
}
`,
};
