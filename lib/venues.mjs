export const VENUES = [
  {
    id: 'M1',
    name: '滨江剧院',
    station: '巡演第一站',
    order: 1,
    source: 'wire',
    phases: ['opening', 'interim', 'confirmed'],
    note: '主舞台检修后沿用侧台吊点；场馆资料按 opening / interim / confirmed 分期发布。',
  },
  {
    id: 'M2',
    name: '港区艺术中心',
    station: '巡演第二站',
    order: 2,
    source: 'local',
    dir: 'm2',
    phases: ['confirmed'],
    finalPhase: 'confirmed',
    defaultPhase: 'confirmed',
    note: '下一站沿用同一批景片，但吊点、限额与证书均按当地场馆另行发布。',
  },
];

export function getVenue(id) {
  return VENUES.find((venue) => venue.id === id) ?? null;
}

export function venuePhases(venue) {
  return venue?.phases ?? ['confirmed'];
}

export function defaultPhase(venue) {
  if (!venue) return 'confirmed';
  return venue.defaultPhase ?? venuePhases(venue).at(-1) ?? 'confirmed';
}

export function previousVenues(id) {
  const current = getVenue(id);
  if (!current) return [];
  return VENUES.filter((venue) => venue.order < current.order).sort((a, b) => a.order - b.order);
}
