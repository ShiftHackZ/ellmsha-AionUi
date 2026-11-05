import type { TTeam } from '@/common/types/team/teamTypes';
import { usePendingConfirmationCounts } from './usePendingConfirmationCounts';

export function useSiderTeamBadges(teams: TTeam[]): Map<string, number> {
  const members = teams.flatMap((team) => team.assistants).filter((member) => member.conversation_id);
  const counts = usePendingConfirmationCounts(
    Object.fromEntries(members.map((member) => [member.conversation_id, member.pending_confirmations ?? 0]))
  );
  return new Map(
    teams.map((team) => [
      team.id,
      team.assistants.reduce(
        (sum, member) => sum + (counts[member.conversation_id] ?? member.pending_confirmations ?? 0),
        0
      ),
    ])
  );
}
