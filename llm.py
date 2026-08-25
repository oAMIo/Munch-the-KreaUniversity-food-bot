"""The DeepSeek phrasing pass. The only place an LLM is used at runtime.

Its job is presentation, nothing else (SPEC.md §7): it takes an already-
complete deterministic menu message and restyles it in the configured
persona. It is never given the database, never asked what the menu is,
and never used for ratings or reports.

Called via the `openai` SDK pointed at DeepSeek's OpenAI-compatible API
(there is no dedicated DeepSeek SDK) — see SPEC.md §2 for why.
"""

from __future__ import annotations

import asyncio
import logging

from openai import AsyncOpenAI

from config import LLMConfig

logger = logging.getLogger(__name__)

DEEPSEEK_BASE_URL = "https://api.deepseek.com"


def _build_system_prompt(persona: str) -> str:
    return (
        "You rewrite a mess-menu announcement for a university group chat, in this persona: "
        f"{persona}\n\n"
        "Rules:\n"
        "- Reproduce every dish name exactly as given in the message. Never add, remove, "
        "rename, translate, or invent a dish.\n"
        "- Keep the rewritten announcement under about 40 words, plus the dish list.\n"
        "- Return only the message text. No preamble, no markdown fences, no explanations."
    )


def _all_dishes_present(text: str, dishes: list[str]) -> bool:
    return all(dish in text for dish in dishes)


async def phrase_menu_message(
    llm_cfg: LLMConfig,
    api_key: str | None,
    base_message: str,
    dishes: list[str],
) -> str | None:
    """Return a persona-phrased version of `base_message`, or None on any failure.

    None means "use the deterministic base_message instead" — the caller
    (jobs.post_menu_job) owns that fallback, per SPEC.md §5.4 step 4. This
    function never raises; every failure path is caught and logged here.
    """
    if not llm_cfg.enabled:
        return None

    if not api_key:
        logger.error("LLM phrasing pass skipped: llm.enabled is true but no DeepSeek API key is configured.")
        return None

    try:
        client = AsyncOpenAI(api_key=api_key, base_url=DEEPSEEK_BASE_URL)
        response = await asyncio.wait_for(
            client.chat.completions.create(
                model=llm_cfg.model,
                max_tokens=llm_cfg.max_tokens,
                messages=[
                    {"role": "system", "content": _build_system_prompt(llm_cfg.persona)},
                    {"role": "user", "content": base_message},
                ],
            ),
            timeout=llm_cfg.timeout_seconds,
        )
    except Exception:
        logger.exception("LLM phrasing pass call failed; falling back to deterministic message.")
        return None

    choices = getattr(response, "choices", None)
    if not choices:
        logger.warning("LLM phrasing pass returned no choices; falling back to deterministic message.")
        return None

    phrased = choices[0].message.content
    if not phrased or not phrased.strip():
        logger.warning("LLM phrasing pass returned empty content; falling back to deterministic message.")
        return None

    phrased = phrased.strip()

    if not _all_dishes_present(phrased, dishes):
        missing = [dish for dish in dishes if dish not in phrased]
        logger.warning(
            "LLM phrasing pass dropped dish name(s) %r; discarding output, falling back to deterministic message.",
            missing,
        )
        return None

    return phrased
