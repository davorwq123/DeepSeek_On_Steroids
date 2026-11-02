/**
 * The tools a DeepSeek conversation may request, and their execution.
 *
 * DeepSeek Web has no connector protocol, so the app cannot be an MCP server to it. The same
 * registered Core handlers are invoked in process instead, as the app's own caller: the
 * conversation and durable session are already known here, so no page evidence is claimed or
 * waited for, while every live guard (permissions, approved roots, blocked chats, superseded
 * handoff, recording) still runs exactly once inside the kernel.
 *
 * The catalog is the Core surface minus the tools a text turn cannot use: `session_finish`
 * holds a brokered ChatGPT turn, `usage` reports app accounting, and code-mode `exec` requires
 * a transport request id it does not have. `agents` stays: it is how a DeepSeek prime starts
 * workers and how a worker reports and finishes, and those worker chats are app-owned DeepSeek
 * pages in this build.
 */

import { effectiveCapabilities, getConfig } from '../config.js';
import { createRegistrar, type SurfaceRegistrar, type ToolContext, type ToolResult } from '../mcp/kernel.js';
import { registerCoreTools } from '../mcp/tools-core.js';
import { toolSchemaJson } from '../mcp/tool-declarations.js';
import { withManagedSkills } from '../skill-access.js';
import type { DeepSeekToolDescriptor } from './tool-protocol.js';

/** The Core operations a DeepSeek text turn may ask for, in catalog order. */
const DEEPSEEK_TOOLS = ['read', 'view_image', 'find', 'apply_patch', 'save_image', 'exec_command', 'write_stdin', 'update_plan', 'agents'] as const;

export interface DeepSeekToolHostOptions {
  conversationId: string;
  sessionId: string;
  /** Live permission context; the default reads the app's current settings. */
  ctx?: ToolContext;
  /** Test seam: what the host registers. Defaults to the Core surface. */
  register?: (registrar: SurfaceRegistrar) => void;
}

export interface DeepSeekToolHost {
  /** Exactly what this turn may request, already filtered to the registered capabilities. */
  tools: readonly DeepSeekToolDescriptor[];
  /** Runs one accepted proposal through the kernel and returns what the model may read. */
  run: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

export function liveDeepSeekToolContext(profileId: string | null = getConfig().tunnel.profileId ?? 'default'): ToolContext {
  const config = getConfig();
  return withManagedSkills({
    setupProfileId: profileId ?? undefined,
    roots: config.roots,
    caps: effectiveCapabilities(config),
    readOnly: config.readOnly,
    privacyScreenshots: config.ui.privacyScreenshots
  });
}

function registeredSurface(options: Pick<DeepSeekToolHostOptions, 'ctx' | 'register'> = {}): {
  descriptors: DeepSeekToolDescriptor[];
  registrar: SurfaceRegistrar;
  exposed: Set<string>;
} {
  const ctx = options.ctx ?? liveDeepSeekToolContext();
  const allowed = new Set<string>(DEEPSEEK_TOOLS);
  const descriptors: DeepSeekToolDescriptor[] = [];
  const exposed = new Set<string>();
  const registrar = createRegistrar(null, ctx, 'core', (name, config) => {
    if (!allowed.has(name)) return;
    exposed.add(name);
    descriptors.push({
      name,
      description: config.description,
      inputSchema: { type: 'object', ...toolSchemaJson(config.inputSchema) }
    });
  });
  (options.register ?? registerCoreTools)(registrar);
  return { descriptors, registrar, exposed };
}

/** The catalog alone, for injecting the protocol into a new DeepSeek conversation. */
export function describeDeepSeekTools(options: Pick<DeepSeekToolHostOptions, 'ctx' | 'register'> = {}): DeepSeekToolDescriptor[] {
  return registeredSurface(options).descriptors;
}

export function createDeepSeekToolHost(options: DeepSeekToolHostOptions): DeepSeekToolHost {
  const { descriptors, registrar, exposed } = registeredSurface(options);
  const tools = Object.freeze(descriptors.map(tool => ({ ...tool, inputSchema: Object.freeze(tool.inputSchema) as unknown })));
  const caller = {
    transportKey: null,
    requestId: null,
    conversationId: options.conversationId,
    sessionId: options.sessionId,
    setupProfileId: options.ctx?.setupProfileId ?? null
  } as const;

  return {
    tools,
    run(name, args) {
      // The catalog is the authority, not the registrar's full registration set: an
      // advertisement the model never saw is not an invitation to accept it now.
      if (!exposed.has(name)) {
        return Promise.resolve({ content: [{ type: 'text', text: 'UNKNOWN_TOOL: this conversation does not offer that tool.' }], isError: true });
      }
      return registrar.invoke(name, args, caller);
    }
  };
}

/** One tool result as text, the only shape the DeepSeek text protocol can carry back. */
export function deepSeekToolResultText(result: ToolResult): string {
  const parts = result.content.map(part => {
    if (part.type === 'text') return part.text;
    // The app records the image itself; the model gets its existence, not the pixels,
    // because a JSON envelope cannot turn base64 into an image it can see.
    const bytes = Math.ceil((part.data.length * 3) / 4);
    return `[image ${part.mimeType}, ${bytes} bytes — recorded in the app, not attached to this text reply]`;
  });
  // Core's worker reports and returned identities live here; the short content text may only
  // summarize them. Both representations share the turn owner's existing result/message budget.
  if (result.structuredContent) parts.push(`Structured result:\n${JSON.stringify(result.structuredContent)}`);
  return parts.join('\n');
}
