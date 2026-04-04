"""
MontageDev — Web Search
Uses DuckDuckGo (no API key) to search, formats results for the AI.
Integrates with Groq tool-calling so the model can decide when to search.
"""
import json


def search_web(query: str, max_results: int = 6) -> str:
    """
    Runs a DuckDuckGo search and returns formatted results as a string
    to inject into the AI context.
    """
    try:
        from duckduckgo_search import DDGS
        with DDGS() as ddg:
            results = list(ddg.text(query, max_results=max_results))
    except Exception as e:
        return f"[Web search failed: {e}]"

    if not results:
        return f"[No results found for: {query}]"

    lines = [f"Web search results for: \"{query}\"\n"]
    for i, r in enumerate(results, 1):
        title = r.get("title", "No title")
        body  = r.get("body",  "")[:400]
        href  = r.get("href",  "")
        lines.append(f"[{i}] {title}\n{body}\nSource: {href}\n")

    return "\n".join(lines)


# ──────────────────────────────────────────────────────────────────────────────
# Groq tool definition
# ──────────────────────────────────────────────────────────────────────────────

WEB_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": (
            "Search the internet for current, real-time information. "
            "Use this when the user asks about recent events, current prices, "
            "news, today's date, live data, or anything that may have changed "
            "after your training cutoff."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query to look up on the web. Be concise and specific.",
                }
            },
            "required": ["query"],
        },
    },
}


def handle_tool_calls(tool_calls: list) -> list[dict]:
    """
    Given a list of Groq tool_call objects, execute each one and return
    a list of tool_result messages for the next API call.
    """
    results = []
    for tc in tool_calls:
        fn_name = tc.function.name
        try:
            args = json.loads(tc.function.arguments)
        except Exception:
            args = {}

        if fn_name == "web_search":
            query  = args.get("query", "")
            output = search_web(query)
        else:
            output = f"[Unknown tool: {fn_name}]"

        results.append({
            "role": "tool",
            "tool_call_id": tc.id,
            "content": output,
        })

    return results
