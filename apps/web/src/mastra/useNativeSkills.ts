import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { SkillCatalogState } from '../composer/useSkillCatalog';
import { errorMessageFrom } from '../shared/values';
import { mastraClient } from './client';

/** The native catalog is read in its authoritative chat or draft-project scope.
 * A new scope has no previous catalog while its native read is pending.
 */
export function useNativeSkills({ chatId, projectId, epoch, cwd, enabled }: {
  chatId: string | null; projectId: string | null; epoch?: string; cwd?: string | null; enabled: boolean;
}): SkillCatalogState {
  const selector = chatId ? { chatId } : { projectId };
  const query = useQuery({ queryKey: ['mastra', 'skills', selector, epoch, cwd], enabled, retry: false,
    queryFn: ({ signal }) => mastraClient.listSkills(selector, { signal }) });
  const skills = useMemo(() => (query.data?.skills ?? []).map(skill => ({ ...skill, enabled: true })), [query.data]);
  return { skills: enabled ? skills : [], error: query.error ? errorMessageFrom(query.error) : null,
    loading: query.isLoading || query.isFetching };
}
