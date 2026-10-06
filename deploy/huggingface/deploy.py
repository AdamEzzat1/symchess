"""Publish SymChess to a Hugging Face Space (free "CPU basic" Docker Space).

One-time setup, done by you:
    1. Create a free account at https://huggingface.co
    2. Create an access token with WRITE permission:
       https://huggingface.co/settings/tokens
    3. Log in on this machine (paste the token when asked):
           huggingface-cli login

Then, from the repository root:
    python deploy/huggingface/deploy.py                  # Space named "symchess"
    python deploy/huggingface/deploy.py my-space-name

Run it again any time to publish a new version. The Space rebuilds the Docker
image itself; the first build compiles SBCL and takes several minutes.
"""

import sys
from pathlib import Path

from huggingface_hub import HfApi

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent


def main() -> int:
    api = HfApi()
    try:
        user = api.whoami()["name"]
    except Exception:
        print("Not logged in to Hugging Face. Run:  huggingface-cli login")
        return 1

    name = sys.argv[1] if len(sys.argv) > 1 else "symchess"
    repo_id = name if "/" in name else f"{user}/{name}"

    api.create_repo(repo_id, repo_type="space", space_sdk="docker", exist_ok=True)

    # Only what the Docker build needs. The Space's README (with the metadata
    # block Hugging Face requires) is uploaded separately so the GitHub README
    # stays a normal README.
    api.upload_folder(
        repo_id=repo_id,
        repo_type="space",
        folder_path=str(ROOT),
        allow_patterns=["Dockerfile", ".dockerignore", "engine/**", "knowledge/**", "web/**"],
        ignore_patterns=["**/node_modules/**", "web/dist/**", "**/*.fasl", "engine/tests/**", "knowledge/tests/**"],
        commit_message="Deploy SymChess",
    )
    api.upload_file(
        repo_id=repo_id,
        repo_type="space",
        path_or_fileobj=str(HERE / "README.md"),
        path_in_repo="README.md",
        commit_message="Space metadata",
    )

    owner, space = repo_id.split("/")
    host = f"{owner}-{space}".lower().replace("_", "-").replace(".", "-")
    print(f"Uploaded. Build progress: https://huggingface.co/spaces/{repo_id}")
    print(f"When the build finishes, share this link: https://{host}.hf.space")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
