import type { MenuService } from '../../menu/menu-service.js';
import type { PosConfigId } from '../../shared/types.js';
import type { CandidateSet } from '../../menu/menu-types.js';

/** Retrieve likely items/modifiers before the LLM call (design §7). */
export function retrieveCandidates(
  menu: MenuService,
  pos_config_id: PosConfigId,
  text: string,
): Promise<CandidateSet> {
  return menu.getCandidates(pos_config_id, text);
}
