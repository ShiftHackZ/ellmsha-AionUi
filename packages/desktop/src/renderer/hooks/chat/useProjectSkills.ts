import { ipcBridge } from '@/common';
import useSWR from 'swr';

/** One cached catalog per owned project; poll only while a picker needs live results. */
export function useProjectSkillCatalog(projectId?: string | null, picking = false) {
  return useSWR(
    projectId ? ['project-skills', projectId] : null,
    ([, id]) => ipcBridge.project.skills.invoke({ project_id: id }),
    {
      refreshInterval: picking ? 5000 : 0,
    }
  );
}

export function useProjectSkills(projectId?: string | null, picking = false) {
  const result = useProjectSkillCatalog(projectId, picking);
  return projectId ? result.data : undefined;
}
