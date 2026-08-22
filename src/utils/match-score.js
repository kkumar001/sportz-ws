export function toPublicMatch(match) {
  if (!match) {
    return match;
  }

  const homeWickets = match.homeWickets ?? 0;
  const awayWickets = match.awayWickets ?? 0;
  const cricket = String(match.sport || '').toLowerCase() === 'cricket';

  return {
    ...match,
    homeWickets,
    awayWickets,
    homeScoreLabel: cricket ? `${match.homeScore}/${homeWickets}` : String(match.homeScore ?? 0),
    awayScoreLabel: cricket ? `${match.awayScore}/${awayWickets}` : String(match.awayScore ?? 0),
  };
}

export function toPublicMatches(rows) {
  return rows.map((row) => toPublicMatch(row));
}
