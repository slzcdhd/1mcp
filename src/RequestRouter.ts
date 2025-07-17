/**
 * Request Router for 1mcp
 * Routes requests to appropriate upstream servers based on prefixed capability names
 */

import { CapabilityRegistry, PrefixUtility } from './CapabilityRegistry.js';
import { UpstreamManager } from './UpstreamManager.js';
import { MCPRequest, MCPResponse, RegisteredTool, RegisteredResource } from './types.js';

/**
 * Route information for requests
 */
interface RouteInfo {
  serverName: string;
  originalName: string;
  connector: any; // BaseConnector instance
}

/**
 * Request router handles incoming MCP requests and routes them to appropriate upstream servers
 * Manages prefixed capability names and forwards requests to the correct servers
 */
export class RequestRouter {
  constructor(
    private capabilityRegistry: CapabilityRegistry,
    private upstreamManager: UpstreamManager,
    private prefixUtils: PrefixUtility
  ) {}

  /**
   * Route a tool call to the appropriate upstream server
   */
  routeToolCall(prefixedName: string): RouteInfo | null {
    // Parse the prefixed name
    const parsed = this.prefixUtils.removePrefix(prefixedName);
    if (!parsed) {
      console.warn(`⚠️  Invalid prefixed tool name: ${prefixedName}`);
      return null;
    }

    const { serverName, originalName } = parsed;

    // Verify the tool exists in the registry
    const registeredTool = this.capabilityRegistry.getTool(prefixedName);
    if (!registeredTool) {
      console.warn(`⚠️  Tool not found in registry: ${prefixedName}`);
      return null;
    }

    // Get the connector for this server
    const connector = this.upstreamManager.getConnector(serverName);
    if (!connector) {
      console.error(`❌ No connector found for server: ${serverName}`);
      return null;
    }

    if (!connector.isConnected()) {
      console.error(`❌ Server not connected: ${serverName}`);
      return null;
    }

    return {
      serverName,
      originalName,
      connector
    };
  }

  /**
   * Route a resource read to the appropriate upstream server
   */
  routeResourceRead(prefixedUri: string): RouteInfo | null {
    // Parse the prefixed URI
    const parsed = this.prefixUtils.removePrefix(prefixedUri);
    if (!parsed) {
      console.warn(`⚠️  Invalid prefixed resource URI: ${prefixedUri}`);
      return null;
    }

    const { serverName, originalName } = parsed;

    // Verify the resource exists in the registry
    const registeredResource = this.capabilityRegistry.getResource(prefixedUri);
    if (!registeredResource) {
      console.warn(`⚠️  Resource not found in registry: ${prefixedUri}`);
      return null;
    }

    // Get the connector for this server
    const connector = this.upstreamManager.getConnector(serverName);
    if (!connector) {
      console.error(`❌ No connector found for server: ${serverName}`);
      return null;
    }

    if (!connector.isConnected()) {
      console.error(`❌ Server not connected: ${serverName}`);
      return null;
    }

    return {
      serverName,
      originalName,
      connector
    };
  }

  /**
   * Route an incoming MCP request to the appropriate handler
   */
  async routeRequest(request: MCPRequest): Promise<MCPResponse> {
    try {
      switch (request.method) {
        case 'initialize':
          return this.handleInitialize(request);
        
        case 'tools/call':
          return await this.handleToolCall(request);
        
        case 'resources/read':
          return await this.handleResourceRead(request);
        
        case 'tools/list':
          return this.handleListTools(request);
        
        case 'resources/list':
          return this.handleListResources(request);
        
        case 'ping':
          return this.handlePing(request);
        
        case 'notifications/initialized':
          return this.handleNotification(request);
          
        case 'notifications/cancelled':
          return this.handleNotification(request);
        
        default:
          console.warn(`⚠️  Unknown method: ${request.method}`);
          return {
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32601,
              message: `Method not found: ${request.method}`
            }
          };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`❌ Error routing request ${request.method}:`, errorMessage);
      
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32603,
          message: `Internal error: ${errorMessage}`
        }
      };
    }
  }

  /**
   * Handle notification messages
   */
  private handleNotification(request: MCPRequest): MCPResponse {
    console.log(`📩 Processing notification: ${request.method}`);
    
    // For notifications, we typically just acknowledge receipt
    // Most notification handlers don't need to return specific data
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        acknowledged: true,
        timestamp: new Date().toISOString()
      }
    };
  }

  /**
   * Handle ping requests - simple health check
   */
  private handlePing(request: MCPRequest): MCPResponse {
    console.log(`🏓 Processing ping request ${request.id}`);
    
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        message: 'pong',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        serverInfo: {
          name: '1mcp',
          version: '1.0.0'
        }
      }
    };
  }

  /**
   * Handle initialize requests - return server capabilities and protocol info
   */
  private handleInitialize(request: MCPRequest): MCPResponse {
    console.log(`🤝 Processing initialize request from client`);
    
    const summary = this.capabilityRegistry.getSummary();
    const connectedServers = this.upstreamManager.getConnectedServers();
    
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        // protocolVersion field removed for simplified architecture
        capabilities: {
          tools: {
            listChanged: true  // Support for tools/list_changed notifications
          },
          resources: {
            listChanged: true,  // Support for resources/list_changed notifications
            subscribe: false    // Don't support resource subscription yet
          },
          experimental: {
            // Experimental capabilities
            search: true,       // Support for searching capabilities
            health: true,       // Support for health checks
            aggregation: true   // This is an aggregation server
          }
        },
        serverInfo: {
          name: '1mcp',
          version: '1.0.0',
          description: 'A central proxy server that aggregates multiple upstream MCP servers',
          aggregatedServers: connectedServers.length,
          totalTools: summary.totalTools,
          totalResources: summary.totalResources,
          totalPrompts: summary.totalPrompts,
          protocols: ['stdio', 'sse', 'streamable-http'],
          endpoints: {
            http: '/mcp',
            sse: '/mcp/sse',
            stream: '/mcp/stream',
            health: '/health',
            search: '/mcp/search'
          }
        }
      }
    };
  }

  /**
   * Handle tool call requests
   */
  private async handleToolCall(request: MCPRequest): Promise<MCPResponse> {
    const { name: prefixedName, arguments: args } = request.params;
    
    if (!prefixedName || typeof prefixedName !== 'string') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32602,
          message: 'Invalid params: tool name is required'
        }
      };
    }

    // Route the tool call
    const routeInfo = this.routeToolCall(prefixedName);
    if (!routeInfo) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32601,
          message: `Tool not found or server unavailable: ${prefixedName}`
        }
      };
    }

    // Create the upstream request with original (unprefixed) name
    const upstreamRequest: MCPRequest = {
      jsonrpc: '2.0',
      id: request.id,
      method: 'tools/call',
      params: {
        name: routeInfo.originalName,
        arguments: args
      }
    };

    console.log(`🔀 Routing tool call ${prefixedName} → ${routeInfo.serverName}.${routeInfo.originalName}`);

    try {
      return await routeInfo.connector.sendMessage(upstreamRequest);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32603,
          message: `Upstream error: ${errorMessage}`
        }
      };
    }
  }

  /**
   * Handle resource read requests
   */
  private async handleResourceRead(request: MCPRequest): Promise<MCPResponse> {
    const { uri: prefixedUri } = request.params;
    
    if (!prefixedUri || typeof prefixedUri !== 'string') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32602,
          message: 'Invalid params: resource URI is required'
        }
      };
    }

    // Route the resource read
    const routeInfo = this.routeResourceRead(prefixedUri);
    if (!routeInfo) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32601,
          message: `Resource not found or server unavailable: ${prefixedUri}`
        }
      };
    }

    // Create the upstream request with original (unprefixed) URI
    const upstreamRequest: MCPRequest = {
      jsonrpc: '2.0',
      id: request.id,
      method: 'resources/read',
      params: {
        uri: routeInfo.originalName
      }
    };

    console.log(`🔀 Routing resource read ${prefixedUri} → ${routeInfo.serverName}.${routeInfo.originalName}`);

    try {
      return await routeInfo.connector.sendMessage(upstreamRequest);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32603,
          message: `Upstream error: ${errorMessage}`
        }
      };
    }
  }

  /**
   * Handle list tools requests - return aggregated tools from all servers
   */
  private handleListTools(request: MCPRequest): MCPResponse {
    try {
      const allTools = this.capabilityRegistry.getAllTools();
      
      // Convert RegisteredTool back to MCPTool format for the response
      const tools = allTools.map(registeredTool => ({
        name: registeredTool.prefixedName, // Use prefixed name for clients
        description: registeredTool.description,
        inputSchema: registeredTool.parameters || {
          type: 'object',
          properties: {},
          required: []
        }
      }));

      console.log(`📋 Listing ${tools.length} aggregated tools`);

      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32603,
          message: `Failed to list tools: ${errorMessage}`
        }
      };
    }
  }

  /**
   * Handle list resources requests - return aggregated resources from all servers
   */
  private handleListResources(request: MCPRequest): MCPResponse {
    try {
      const allResources = this.capabilityRegistry.getAllResources();
      
      // Convert RegisteredResource back to MCPResource format for the response
      const resources = allResources.map(registeredResource => ({
        uri: registeredResource.prefixedUri, // Use prefixed URI for clients
        name: registeredResource.name,
        description: registeredResource.description,
        mimeType: registeredResource.mimeType
      }));

      console.log(`📚 Listing ${resources.length} aggregated resources`);

      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          resources
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32603,
          message: `Failed to list resources: ${errorMessage}`
        }
      };
    }
  }

  /**
   * Get routing statistics
   */
  getStats(): {
    totalTools: number;
    totalResources: number;
    totalPrompts: number;
    connectedServers: number;
    totalServers: number;
  } {
    const summary = this.capabilityRegistry.getSummary();
    const connectedServers = this.upstreamManager.getConnectedServers();
    const totalServers = this.upstreamManager.getServerNames();

    return {
      totalTools: summary.totalTools,
      totalResources: summary.totalResources,
      totalPrompts: summary.totalPrompts,
      connectedServers: connectedServers.length,
      totalServers: totalServers.length
    };
  }

  /**
   * Check if a capability is available
   */
  isCapabilityAvailable(prefixedName: string, type: 'tool' | 'resource'): boolean {
    const parsed = this.prefixUtils.removePrefix(prefixedName);
    if (!parsed) {
      return false;
    }

    const { serverName } = parsed;
    const connector = this.upstreamManager.getConnector(serverName);
    
    if (!connector || !connector.isConnected()) {
      return false;
    }

    // Check if the capability is registered
    if (type === 'tool') {
      return this.capabilityRegistry.getTool(prefixedName) !== null;
    } else {
      return this.capabilityRegistry.getResource(prefixedName) !== null;
    }
  }

  /**
   * Get available capability names by type
   */
  getCapabilityNames(type: 'tool' | 'resource'): string[] {
    if (type === 'tool') {
      return this.capabilityRegistry.getAllTools().map(tool => tool.prefixedName);
    } else {
      return this.capabilityRegistry.getAllResources().map(resource => resource.prefixedUri);
    }
  }

  /**
   * Search capabilities by name or description
   */
  searchCapabilities(query: string, type?: 'tool' | 'resource'): {
    tools: RegisteredTool[];
    resources: RegisteredResource[];
  } {
    const lowerQuery = query.toLowerCase();
    
    let tools: RegisteredTool[] = [];
    let resources: RegisteredResource[] = [];

    if (!type || type === 'tool') {
      tools = this.capabilityRegistry.getAllTools().filter(tool =>
        tool.prefixedName.toLowerCase().includes(lowerQuery) ||
        tool.description.toLowerCase().includes(lowerQuery)
      );
    }

    if (!type || type === 'resource') {
      resources = this.capabilityRegistry.getAllResources().filter(resource =>
        resource.prefixedUri.toLowerCase().includes(lowerQuery) ||
        resource.name?.toLowerCase().includes(lowerQuery) ||
        resource.description?.toLowerCase().includes(lowerQuery)
      );
    }

    return { tools, resources };
  }
} 