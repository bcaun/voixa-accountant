// The firm's own audit log: settings, team and security changes, kept apart from the clients' logs.
export async function firmEvent(db, firmId, user, type, text, data = {}) {
  if (!firmId) return;
  await db.query('insert into firm_events (firm_id, actor_id, actor_name, type, text, data) values ($1,$2,$3,$4,$5,$6)',
    [firmId, user?.id ?? null, user ? (user.name || user.email) : 'Pescada', type, text, data]);
}
