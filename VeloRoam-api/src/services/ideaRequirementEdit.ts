import { ConversationIntent, sanitizeConversationIntent } from './ideaIntent';
import type { RequirementState } from './ideaRequirementState';

export const EDITABLE_REQUIREMENTS = ['origin', 'destination', 'place', 'targetKm', 'minKm', 'maxKm', 'targetMinutes', 'minMinutes', 'maxMinutes', 'stopMinutes', 'preferences'] as const;
type Field = typeof EDITABLE_REQUIREMENTS[number];
const distanceFields = new Set<Field>(['targetKm', 'minKm', 'maxKm']);
const minuteFields = new Set<Field>(['targetMinutes', 'minMinutes', 'maxMinutes', 'stopMinutes']);
const textFields = new Set<Field>(['origin', 'destination', 'place']);
export type RequirementEdit = { field: Field; value: string | number | null };

/** User-originated field edit; this never invokes a model or starts planning. */
export function applyRequirementEdit(intent: ConversationIntent | null, request: unknown, previous: RequirementState | null): { intent: ConversationIntent; interpretation: object } {
  if (!intent || intent.requestType !== 'route' || !request || typeof request !== 'object') throw new Error('没有可修改的路线需求，请先描述骑行想法。');
  const edit = request as Record<string, unknown>;
  if (Object.keys(edit).some(key => key !== 'field' && key !== 'value') || typeof edit.field !== 'string' || !(EDITABLE_REQUIREMENTS as readonly string[]).includes(edit.field)) throw new Error('无法识别要修改的需求，请重试。');
  const field = edit.field as Field;
  const raw = edit.value;
  let value: string | number | string[] | null = null;
  if (raw !== null) {
    if (distanceFields.has(field) || minuteFields.has(field)) {
      const max = distanceFields.has(field) ? 1000 : 10080;
      const allowZero = field === 'minKm' || field === 'minMinutes' || field === 'stopMinutes';
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || (!allowZero && raw === 0) || raw > max) throw new Error(`请输入有效的${distanceFields.has(field) ? '公里数' : '分钟数'}。`);
      value = raw;
    } else if (textFields.has(field)) {
      if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 80) throw new Error('请输入 80 字以内的地点。');
      value = raw.trim();
    } else {
      if (typeof raw !== 'string' || raw.length > 500) throw new Error('请输入有效的骑行偏好。');
      const parts = [...new Set(raw.split(/[、，,;；\n]/).map(x => x.trim()).filter(Boolean))];
      if (!parts.length || parts.length > 8 || parts.some(x => x.length > 80)) throw new Error('请填写不超过 8 条、每条不超过 80 字的偏好。');
      value = parts;
    }
  }
  const changedFields: string[] = [field];
  const next: any = { ...intent, [field]: value === null && field === 'preferences' ? [] : value };
  // An explicitly selected end replaces returning to the starting point.
  if (field === 'destination' && value !== null && intent.returnToStart) { next.returnToStart = false; changedFields.push('returnToStart'); }
  const sanitized = sanitizeConversationIntent(next)!;
  if ((sanitized.minKm != null && sanitized.maxKm != null && sanitized.minKm > sanitized.maxKm) || (sanitized.minMinutes != null && sanitized.maxMinutes != null && sanitized.minMinutes > sanitized.maxMinutes)) throw new Error('下限不能高于上限，请先调整范围。');
  sanitized.confirmationPending = true;
  const existing = previous?.requirements?.[field];
  const priority = existing && ['required', 'preferred'].includes(existing.priority) ? existing.priority : null;
  return { intent: sanitized, interpretation: { changedFields, ...(priority && value !== null ? { [priority === 'required' ? 'requiredFields' : 'preferredFields']: [field] } : {}) } };
}
