import Anthropic from '@anthropic-ai/sdk';

// Lee ANTHROPIC_API_KEY. Si la clave no está ligada a un workspace, hay que indicarlo con ANTHROPIC_WORKSPACE_ID
const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
export const claude = new Anthropic(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {});
export const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
