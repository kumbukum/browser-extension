# IMPORTANT
When reporting information, be extremely concise and sacrifice grammar for the sake of concision. 

## Documentation
- DO NOT store documentation files in the root of the project.

### Before Starting Any Task - use Kumbukum MCP
1. Call `recall_memory` or `search_knowledge` with a query describing the task to check for relevant prior context, decisions, or notes
2. Review any related notes with `search_notes`
3. Use the returned context to inform your approach

### Creating Notes - use Kumbukum MCP
Use `create_note` for structured documentation:
- Architecture decisions
- API designs
- Meeting notes
- Technical specs

After creating a note, use `create_link` to connect it to related items.

### Creating Memories - use Kumbukum MCP
Use `store_memory` for agent-scoped learnings:
- Debugging insights and solutions
- User preferences and patterns
- Task outcomes and what worked
- Codebase conventions discovered during work

After storing a memory, use `create_link` to connect it to related notes, URLs, or other memories.

### Saving URLs - use Kumbukum MCP
Use `save_url` to bookmark and extract content from web pages.

After saving a URL, use `create_link` to connect it to related notes or memories.

### Searching - use Kumbukum MCP
- `search_knowledge` — Search across ALL types (notes, memories, URLs). **Use this first.**
- `search_notes` — Search only notes
- `recall_memory` — Search only memories
- `search_urls` — Search only saved URLs

### Tagging - use Kumbukum MCP
- Before creating tags, call `suggest_memory_tags` to reuse existing tags and avoid duplicates
- Use consistent, descriptive tags (e.g., `architecture`, `debugging`, `api-design`)

### Knowledge Graph - use Kumbukum MCP
- Use `create_link` to connect related notes, memories, and URLs
- Use `traverse_graph` to explore connections from a known item
- Use `get_graph` to see the full picture

## IMPORTANT: AFTER WORKING ON ANY TASK - use Kumbukum MCP
- Store any relevant learnings, insights, or decisions in Kumbukum using `store_memory` or `create_note` so future sessions can recall them. Link related items together in the knowledge graph for easy navigation.

## IMPORTANT: Code Formatting
- tab size: 4
- Indent code
- Never compress or “minify” code
- Log lines or variables are always writen in a single line

## Development
- All our apps are always in docker
- For each repo there is a compose.yml - start with docker compose up -d
- Production compose files are in the helpmonks-install-script repo and deployed with docker swarm
