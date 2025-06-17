import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * MCP Session Manager
 * Solves the problem of reconnecting on every tool call, supports servers like playwright-mcp that require state persistence
 */
export class McpSessionManager {
	private static instances = new Map<string, McpSessionManager>();
	private client: Client | null = null;
	private transport: Transport | null = null;
	private isConnected = false;
	private connectionPromise: Promise<void> | null = null;
	private lastUsed = Date.now();
	private readonly sessionId: string;
	private cleanupTimer: NodeJS.Timeout | null = null;

	// Session timeout (milliseconds) - 30 minutes
	private static readonly SESSION_TIMEOUT = 30 * 60 * 1000;
	// Cleanup check interval (milliseconds) - 5 minutes
	private static readonly CLEANUP_INTERVAL = 5 * 60 * 1000;

	private constructor(sessionId: string) {
		this.sessionId = sessionId;
		this.startCleanupTimer();
	}

	/**
	 * Get or create session manager instance
	 * @param sessionId Session ID (generated based on connection parameters)
	 * @returns Session manager instance
	 */
	static getInstance(sessionId: string): McpSessionManager {
		if (!McpSessionManager.instances.has(sessionId)) {
			McpSessionManager.instances.set(sessionId, new McpSessionManager(sessionId));
		}
		const instance = McpSessionManager.instances.get(sessionId)!;
		instance.lastUsed = Date.now();
		return instance;
	}

	/**
	 * Generate session ID
	 * @param connectionConfig Connection configuration
	 * @returns Session ID
	 */
	static generateSessionId(connectionConfig: {
		connectionType: string;
		command?: string;
		args?: string[];
		env?: Record<string, string>;
		httpStreamUrl?: string;
		sseUrl?: string;
		headers?: Record<string, string>;
	}): string {
		const configStr = JSON.stringify(connectionConfig);
		// Use simple hash function to generate session ID
		let hash = 0;
		for (let i = 0; i < configStr.length; i++) {
			const char = configStr.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return `mcp_session_${Math.abs(hash).toString(36)}`;
	}

	/**
	 * Connect to MCP server
	 * @param transport Transport layer instance
	 * @returns Promise<Client>
	 */
	async connect(transport: Transport): Promise<Client> {
		// If already connected, return client directly
		if (this.isConnected && this.client) {
			this.lastUsed = Date.now();
			return this.client;
		}

		// If connecting, wait for connection to complete
		if (this.connectionPromise) {
			await this.connectionPromise;
			if (this.isConnected && this.client) {
				this.lastUsed = Date.now();
				return this.client;
			}
		}

		// Start new connection
		this.connectionPromise = this.doConnect(transport);
		await this.connectionPromise;
		this.connectionPromise = null;

		if (!this.client) {
			throw new Error('Failed to establish MCP connection');
		}

		this.lastUsed = Date.now();
		return this.client;
	}

	/**
	 * Execute actual connection logic
	 * @param transport Transport layer instance
	 */
	private async doConnect(transport: Transport): Promise<void> {
		try {
			// Clean up old connections
			await this.cleanup();

			// Create new client
			this.client = new Client(
				{
					name: 'n8n-mcp-client',
					version: '1.0.0',
				},
				{
					capabilities: {
						prompts: {},
						resources: {},
						tools: {},
					},
				},
			);

			// Set transport error handling
			transport.onerror = (error: Error) => {
				console.error(`MCP Transport error for session ${this.sessionId}:`, error.message);
				this.isConnected = false;
				// Don't clean up immediately, allow reconnection
			};

			// Connect to server
			await this.client.connect(transport);
			this.transport = transport;
			this.isConnected = true;

			console.log(`MCP session ${this.sessionId} connected successfully`);
		} catch (error) {
			this.isConnected = false;
			this.client = null;
			this.transport = null;
			throw new Error(`Failed to connect MCP session ${this.sessionId}: ${(error as Error).message}`);
		}
	}

	/**
	 * Get client instance
	 * @returns Client instance or null
	 */
	getClient(): Client | null {
		if (this.isConnected && this.client) {
			this.lastUsed = Date.now();
			return this.client;
		}
		return null;
	}

	/**
	 * Check connection status
	 * @returns Whether connected
	 */
	isSessionConnected(): boolean {
		return this.isConnected && this.client !== null;
	}

	/**
	 * Clean up session
	 */
	async cleanup(): Promise<void> {
		if (this.cleanupTimer) {
			clearTimeout(this.cleanupTimer);
			this.cleanupTimer = null;
		}

		if (this.transport) {
			try {
				await this.transport.close();
			} catch (error) {
				console.error(`Error closing transport for session ${this.sessionId}:`, error);
			}
			this.transport = null;
		}

		this.client = null;
		this.isConnected = false;
		console.log(`MCP session ${this.sessionId} cleaned up`);
	}

	/**
	 * Start cleanup timer
	 */
	private startCleanupTimer(): void {
		this.cleanupTimer = setTimeout(() => {
			this.checkAndCleanupExpiredSessions();
		}, McpSessionManager.CLEANUP_INTERVAL);
	}

	/**
	 * Check and clean up expired sessions
	 */
	private checkAndCleanupExpiredSessions(): void {
		const now = Date.now();
		const expiredSessions: string[] = [];

		for (const [sessionId, instance] of McpSessionManager.instances) {
			if (now - instance.lastUsed > McpSessionManager.SESSION_TIMEOUT) {
				expiredSessions.push(sessionId);
			}
		}

		// Clean up expired sessions
		for (const sessionId of expiredSessions) {
			const instance = McpSessionManager.instances.get(sessionId);
			if (instance) {
				instance.cleanup().catch(error => {
					console.error(`Error cleaning up expired session ${sessionId}:`, error);
				});
				McpSessionManager.instances.delete(sessionId);
				console.log(`Expired MCP session ${sessionId} removed`);
			}
		}

		// Restart timer
		if (McpSessionManager.instances.size > 0) {
			this.startCleanupTimer();
		}
	}

	/**
	 * Force cleanup all sessions (for application shutdown)
	 */
	static async cleanupAllSessions(): Promise<void> {
		const cleanupPromises: Promise<void>[] = [];

		for (const [, instance] of McpSessionManager.instances) {
			cleanupPromises.push(instance.cleanup());
		}

		await Promise.all(cleanupPromises);
		McpSessionManager.instances.clear();
		console.log('All MCP sessions cleaned up');
	}

	/**
	 * Get session statistics
	 */
	static getSessionStats(): {
		totalSessions: number;
		connectedSessions: number;
		sessions: Array<{
			sessionId: string;
			isConnected: boolean;
			lastUsed: Date;
			age: number;
		}>;
	} {
		const now = Date.now();
		const sessions = Array.from(McpSessionManager.instances.entries()).map(([sessionId, instance]) => ({
			sessionId,
			isConnected: instance.isConnected,
			lastUsed: new Date(instance.lastUsed),
			age: now - instance.lastUsed,
		}));

		return {
			totalSessions: McpSessionManager.instances.size,
			connectedSessions: sessions.filter(s => s.isConnected).length,
			sessions,
		};
	}
}