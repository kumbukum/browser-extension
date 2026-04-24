# Instructions

- When reporting information, be extremely concise and sacrifice grammar for the sake of concision. 

## Documentation
- DO NOT store documentation files in the root of the project.

### Before Starting Any Task
1. Call `recall_memory` or `search_knowledge` with a query describing the task to check for relevant prior context, decisions, or notes
2. Review any related notes with `search_notes`
3. Use the returned context to inform your approach

### Creating Notes
Use `create_note` for structured documentation:
- Architecture decisions
- API designs
- Meeting notes
- Technical specs

After creating a note, use `create_link` to connect it to related items.

### Creating Memories
Use `store_memory` for agent-scoped learnings:
- Debugging insights and solutions
- User preferences and patterns
- Task outcomes and what worked
- Codebase conventions discovered during work

After storing a memory, use `create_link` to connect it to related notes, URLs, or other memories.

### Saving URLs
Use `save_url` to bookmark and extract content from web pages.

After saving a URL, use `create_link` to connect it to related notes or memories.

### Searching
- `search_knowledge` — Search across ALL types (notes, memories, URLs). **Use this first.**
- `search_notes` — Search only notes
- `recall_memory` — Search only memories
- `search_urls` — Search only saved URLs

### Tagging
- Before creating tags, call `suggest_memory_tags` to reuse existing tags and avoid duplicates
- Use consistent, descriptive tags (e.g., `architecture`, `debugging`, `api-design`)

### Knowledge Graph
- Use `create_link` to connect related notes, memories, and URLs
- Use `traverse_graph` to explore connections from a known item
- Use `get_graph` to see the full picture

## IMPORTANT: AFTER WORKING ON ANY TASK
- Store any relevant learnings, insights, or decisions in Kumbukum using `store_memory` or `create_note` so future sessions can recall them. Link related items together in the knowledge graph for easy navigation.
