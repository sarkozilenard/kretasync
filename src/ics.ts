const VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Budapest',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

export interface IcsLesson {
  external_id: string; lesson_name: string; start_date: string; end_date: string; lesson_index: number | null;
  classroom_name: string | null; teacher_name: string | null; substitute_teacher_name: string | null; updated_at: Date | string;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** RFC 5545 sortörés 75 oktettnél (UTF-8 karaktert nem vág ketté). */
function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = []; let cur = ''; let bytes = 0; let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > limit) { parts.push(cur); cur = ''; bytes = 0; limit = 74; }
    cur += ch; bytes += b;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

const local = (s: string) => s.replace(/[-: ]/g, '').replace(/^(\d{8})(\d{4})$/, '$1T$200');
const utcStamp = (d: Date | string) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function buildIcs(lessons: IcsLesson[], now: Date = new Date()): string {
  const L: string[] = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//KretaSync//Orarend//HU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:KrétaSync – Órarend', 'X-WR-TIMEZONE:Europe/Budapest',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H', ...VTIMEZONE,
  ];
  for (const l of lessons) {
    const desc = [
      l.lesson_index != null ? `Óraszám: ${l.lesson_index}.` : null,
      l.teacher_name ? `Tanár: ${l.teacher_name}` : null,
      l.substitute_teacher_name ? `Helyettesítő tanár: ${l.substitute_teacher_name}` : null,
    ].filter(Boolean).join('\n');
    const title = (l.lesson_index != null ? `${l.lesson_index}. ` : '') + l.lesson_name + (l.substitute_teacher_name ? ' (helyettesítés)' : '');
    L.push(
      'BEGIN:VEVENT',
      `UID:${l.external_id.replace(/[^\w.@-]/g, '_')}@kretasync`,
      `DTSTAMP:${utcStamp(l.updated_at ?? now)}`,
      `LAST-MODIFIED:${utcStamp(l.updated_at ?? now)}`,
      `DTSTART;TZID=Europe/Budapest:${local(l.start_date)}`,
      `DTEND;TZID=Europe/Budapest:${local(l.end_date)}`,
      `SUMMARY:${esc(title)}`,
    );
    if (l.classroom_name) L.push(`LOCATION:${esc(l.classroom_name)}`);
    if (desc) L.push(`DESCRIPTION:${esc(desc)}`);
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
