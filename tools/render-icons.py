"""Gera os PNGs do PWA a partir de public/icons/icon.svg.

Renderiza o SVG com Chrome/Edge headless (fiel a gradientes e blur) e
redimensiona com Pillow. Uso: python tools/render-icons.py
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "public" / "icons"
SOURCE = ICONS / "icon.svg"
RENDER_SIZE = 1024
OUTPUTS = {
    "apple-touch-icon.png": 180,
    "icon-192.png": 192,
    "icon-512.png": 512,
}
BROWSER_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome",
    "chromium",
]


def find_browser() -> str:
    for candidate in BROWSER_CANDIDATES:
        if Path(candidate).exists() or shutil.which(candidate):
            return candidate
    sys.exit("Não encontrei Chrome, Edge ou Chromium para renderizar o SVG.")


def render_svg(browser: str, target: Path) -> None:
    with tempfile.TemporaryDirectory() as profile:
        subprocess.run(
            [
                browser,
                "--headless=new",
                "--disable-gpu",
                "--hide-scrollbars",
                f"--user-data-dir={profile}",
                f"--window-size={RENDER_SIZE},{RENDER_SIZE}",
                f"--screenshot={target}",
                SOURCE.as_uri(),
            ],
            check=True,
            capture_output=True,
            timeout=60,
        )


def main() -> None:
    browser = find_browser()
    with tempfile.TemporaryDirectory() as tmp:
        master = Path(tmp) / "master.png"
        render_svg(browser, master)
        image = Image.open(master).convert("RGB")
        if image.size != (RENDER_SIZE, RENDER_SIZE):
            image = image.crop((0, 0, RENDER_SIZE, RENDER_SIZE))
        for name, size in OUTPUTS.items():
            image.resize((size, size), Image.LANCZOS).save(ICONS / name, optimize=True)
            print(f"  {name} ({size}x{size})")


if __name__ == "__main__":
    main()
