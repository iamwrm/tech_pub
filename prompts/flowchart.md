
````
Create a sequence diagram showing the interaction between [participants] in [system/protocol name]. 

The diagram should:
- Show each participant as a labeled vertical lifeline
- Number each exchange step sequentially (1), (2), (3), etc.
- Use arrows (--->) for requests and (<---) for responses between participants
- Label each arrow with the operation/message name and any relevant parameters
- Include brief server-side annotations next to the lifeline where important state changes or decisions occur (e.g., "Lock granted", "Request queued")
- Cover the full lifecycle of the interaction, including setup/handshake, the main operation, and any contention or error scenarios involving multiple participants
- Use a monospaced, terminal-style font on a dark background for readability

The scenario to illustrate: [describe the specific workflow, e.g., "Two clients competing for a file lock, where Client A successfully acquires the lock first, then Client B attempts to acquire the same lock"]

For each step, show the request and its corresponding response as a pair. Include any confirmation or acknowledgment messages that are part of the protocol.
````
