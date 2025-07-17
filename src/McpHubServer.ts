/**
 * MCP Hub Server implementation using official SDK
 * Aggregates multiple upstream MCP servers and provides unified interface
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CapabilityRegistry, PrefixUtility } from './CapabilityRegistry.js';
import { UpstreamManager } from './UpstreamManager.js';
import { MCPRequest } from './types.js';

export class McpHubServer {
  private server: Server;
  private capabilityRegistry: CapabilityRegistry;
  private upstreamManager: UpstreamManager;
  private prefixUtility: PrefixUtility;

  constructor() {
    // Initialize components
    this.capabilityRegistry = new CapabilityRegistry();
    this.upstreamManager = new UpstreamManager(this.capabilityRegistry);
    this.prefixUtility = new PrefixUtility();

    // Create MCP server instance
    this.server = new Server({
      name: '1mcp',
      version: '1.0.0',
      description: 'A central proxy server that aggregates multiple upstream MCP servers'
    }, {
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
      }
    });

    this.setupRequestHandlers();
    this.setupNotificationHandlers();
  }

  /**
   * Set up MCP request handlers using official SDK
   */
  private setupRequestHandlers(): void {
    // Register tools/list handler [[memory:3186256]]
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const allTools = this.capabilityRegistry.getAllTools();
      
      // Convert RegisteredTool back to MCPTool format for the response
      const tools = allTools.map(registeredTool => ({
        name: registeredTool.prefixedName, // Use prefixed name for clients
        description: registeredTool.description,
        inputSchema: registeredTool.parameters || {
          type: 'object' as const,
          properties: {},
          required: []
        }
      }));

      console.log(`📋 Listing ${tools.length} aggregated tools via SDK`);
      return { tools };
    });

    // Register tools/call handler [[memory:3186256]]
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name: prefixedName, arguments: args } = request.params;
      
      if (!prefixedName || typeof prefixedName !== 'string') {
        throw new Error('Tool name is required');
      }

      // Route the tool call
      const routeInfo = this.routeToolCall(prefixedName);
      if (!routeInfo) {
        throw new Error(`Tool not found or server unavailable: ${prefixedName}`);
      }

      // Create the upstream request with original (unprefixed) name
      const upstreamRequest: MCPRequest = {
        jsonrpc: '2.0',
        id: Math.random().toString(36),
        method: 'tools/call',
        params: {
          name: routeInfo.originalName,
          arguments: args
        }
      };

      console.log(`🔀 Routing tool call ${prefixedName} → ${routeInfo.serverName}.${routeInfo.originalName}`);

      try {
        const response = await routeInfo.connector.sendMessage(upstreamRequest);
        
        // Return tool call result in the format expected by SDK
        if (response.result && typeof response.result === 'object' && 'content' in response.result) {
          return response.result;
        } else {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(response.result)
            }]
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Upstream error: ${errorMessage}`
          }]
        };
      }
    });

    // Register resources/list handler [[memory:3186256]]
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const allResources = this.capabilityRegistry.getAllResources();
      
      // Convert RegisteredResource back to MCPResource format for the response
      const resources = allResources.map(registeredResource => ({
        uri: registeredResource.prefixedUri, // Use prefixed URI for clients
        name: registeredResource.name,
        description: registeredResource.description,
        mimeType: registeredResource.mimeType
      }));

      console.log(`📚 Listing ${resources.length} aggregated resources via SDK`);
      return { resources };
    });

    // Register resources/read handler [[memory:3186256]]
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri: prefixedUri } = request.params;
      
      if (!prefixedUri || typeof prefixedUri !== 'string') {
        throw new Error('Resource URI is required');
      }

      // Route the resource read
      const routeInfo = this.routeResourceRead(prefixedUri);
      if (!routeInfo) {
        throw new Error(`Resource not found or server unavailable: ${prefixedUri}`);
      }

      // Create the upstream request with original (unprefixed) URI
      const upstreamRequest: MCPRequest = {
        jsonrpc: '2.0',
        id: Math.random().toString(36),
        method: 'resources/read',
        params: {
          uri: routeInfo.originalName
        }
      };

      console.log(`🔀 Routing resource read ${prefixedUri} → ${routeInfo.serverName}.${routeInfo.originalName}`);

      try {
        const response = await routeInfo.connector.sendMessage(upstreamRequest);
        
        // Return resource read result in the format expected by SDK
        if (response.result && typeof response.result === 'object' && 'contents' in response.result) {
          return response.result;
        } else {
          return {
            contents: [{
              uri: prefixedUri,
              mimeType: 'text/plain',
              text: JSON.stringify(response.result)
            }]
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Upstream error: ${errorMessage}`);
      }
    });
  }

  /**
   * Set up notification handlers for upstream changes
   */
  private setupNotificationHandlers(): void {
    // Listen for upstream server status changes
    this.upstreamManager.on('serverStatusChanged', (serverName: string, status: string) => {
      console.log(`📡 Server ${serverName} status changed: ${status}`);
      
      // Notify clients about capability changes
      this.sendNotification('tools/list_changed', {});
      this.sendNotification('resources/list_changed', {});
    });

    // Listen for capability discovery events
    this.upstreamManager.on('capabilitiesDiscovered', (serverName: string, capabilities: any) => {
      console.log(`🔄 Capabilities discovered for ${serverName}: ${capabilities.tools.length} tools, ${capabilities.resources.length} resources`);
      
      // Notify clients about new tools and resources
      this.sendNotification('tools/list_changed', {});
      if (capabilities.resources.length > 0) {
        this.sendNotification('resources/list_changed', {});
      }
    });

    // Listen for capability discovery failures
    this.upstreamManager.on('capabilityDiscoveryFailed', (serverName: string, error: string) => {
      console.log(`⚠️  Capability discovery failed for ${serverName}: ${error}`);
      
      // Still notify about potential changes
      this.sendNotification('tools/list_changed', {});
      this.sendNotification('resources/list_changed', {});
    });
  }

  /**
   * Send notification to connected clients
   */
  private sendNotification(method: string, params: object): void {
    try {
      // Note: In a full implementation, this would send to all connected clients
      // For the SDK server, notifications are handled by the transport layer
      console.log(`📢 Sending notification: ${method}`, params);
      
      // The actual notification sending would be handled by the transport
      // For now, we just log the notification
    } catch (error) {
      console.error(`❌ Error sending notification ${method}:`, error);
    }
  }

  /**
   * Route a tool call to the appropriate upstream server
   */
  private routeToolCall(prefixedName: string) {
    const tool = this.capabilityRegistry.getTool(prefixedName);
    if (!tool) {
      return null;
    }

    const connector = this.upstreamManager.getConnector(tool.serverName);
    if (!connector || !connector.isConnected()) {
      return null;
    }

    return {
      serverName: tool.serverName,
      originalName: tool.originalName,
      connector
    };
  }

  /**
   * Route a resource read to the appropriate upstream server
   */
  private routeResourceRead(prefixedUri: string) {
    const resource = this.capabilityRegistry.getResource(prefixedUri);
    if (!resource) {
      return null;
    }

    const connector = this.upstreamManager.getConnector(resource.serverName);
    if (!connector || !connector.isConnected()) {
      return null;
    }

    return {
      serverName: resource.serverName,
      originalName: resource.originalUri,
      connector
    };
  }

  /**
   * Get the MCP server instance
   */
  getServer(): Server {
    return this.server;
  }

  /**
   * Get capability registry
   */
  getCapabilityRegistry(): CapabilityRegistry {
    return this.capabilityRegistry;
  }

  /**
   * Get upstream manager
   */
  getUpstreamManager(): UpstreamManager {
    return this.upstreamManager;
  }

  /**
   * Get server statistics
   */
  getStats() {
    const summary = this.capabilityRegistry.getSummary();
    const connectedServerNames = this.upstreamManager.getConnectedServers();
    const connectedServers = connectedServerNames.map(serverName => {
      const connector = this.upstreamManager.getConnector(serverName);
      return {
        name: serverName,
        status: connector?.status || 'unknown',
        toolCount: this.capabilityRegistry.getToolRegistry().getServerToolCount(serverName),
        resourceCount: this.capabilityRegistry.getResourceRegistry().getServerResourceCount(serverName)
      };
    });

    return {
      connectedServers,
      totalTools: summary.totalTools,
      totalResources: summary.totalResources,
      totalPrompts: summary.totalPrompts,
      summary
    };
  }

  /**
   * Public handler for tools/list requests (for HTTP mode)
   */
  async handleToolsList() {
    const allTools = this.capabilityRegistry.getAllTools();
    
    // Convert RegisteredTool back to MCPTool format for the response
    const tools = allTools.map(registeredTool => ({
      name: registeredTool.prefixedName, // Use prefixed name for clients
      description: registeredTool.description,
      inputSchema: registeredTool.parameters || {
        type: 'object' as const,
        properties: {},
        required: []
      }
    }));

    console.log(`📋 Listing ${tools.length} aggregated tools via HTTP`);
    return { tools };
  }

  /**
   * Public handler for tools/call requests (for HTTP mode)
   */
  async handleToolCall(params: any) {
    const { name: prefixedName, arguments: args } = params;
    
    if (!prefixedName || typeof prefixedName !== 'string') {
      throw new Error('Tool name is required');
    }

    // Route the tool call
    const routeInfo = this.routeToolCall(prefixedName);
    if (!routeInfo) {
      throw new Error(`Tool not found or server unavailable: ${prefixedName}`);
    }

    // Create the upstream request with original (unprefixed) name
    const upstreamRequest: MCPRequest = {
      jsonrpc: '2.0',
      id: Math.random().toString(36),
      method: 'tools/call',
      params: {
        name: routeInfo.originalName,
        arguments: args
      }
    };

    console.log(`🔀 Routing tool call ${prefixedName} → ${routeInfo.serverName}.${routeInfo.originalName} via HTTP`);

    try {
      const response = await routeInfo.connector.sendMessage(upstreamRequest);
      
      // Return tool call result in the format expected by SDK
      if (response.result && typeof response.result === 'object' && 'content' in response.result) {
        return response.result;
      } else {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(response.result)
          }]
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Upstream error: ${errorMessage}`
        }]
      };
    }
  }

  /**
   * Public handler for resources/list requests (for HTTP mode)
   */
  async handleResourcesList() {
    const allResources = this.capabilityRegistry.getAllResources();
    
    // Convert RegisteredResource back to MCPResource format for the response
    const resources = allResources.map(registeredResource => ({
      uri: registeredResource.prefixedUri, // Use prefixed URI for clients
      name: registeredResource.name,
      description: registeredResource.description,
      mimeType: registeredResource.mimeType
    }));

    console.log(`📋 Listing ${resources.length} aggregated resources via HTTP`);
    return { resources };
  }

  /**
   * Public handler for resources/read requests (for HTTP mode)
   */
  async handleResourceRead(params: any) {
    const { uri: prefixedUri } = params;
    
    if (!prefixedUri || typeof prefixedUri !== 'string') {
      throw new Error('Resource URI is required');
    }

    // Route the resource read
    const routeInfo = this.routeResourceRead(prefixedUri);
    if (!routeInfo) {
      throw new Error(`Resource not found or server unavailable: ${prefixedUri}`);
    }

    // Create the upstream request with original (unprefixed) URI
    const upstreamRequest: MCPRequest = {
      jsonrpc: '2.0',
      id: Math.random().toString(36),
      method: 'resources/read',
      params: {
        uri: routeInfo.originalName
      }
    };

    console.log(`🔀 Routing resource read ${prefixedUri} → ${routeInfo.serverName}.${routeInfo.originalName} via HTTP`);

    try {
      const response = await routeInfo.connector.sendMessage(upstreamRequest);
      
      // Return resource read result in the format expected by SDK
      if (response.result && typeof response.result === 'object' && 'contents' in response.result) {
        return response.result;
      } else {
        return {
          contents: [{
            uri: prefixedUri,
            mimeType: 'text/plain',
            text: JSON.stringify(response.result)
          }]
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Upstream error: ${errorMessage}`);
    }
  }
} 