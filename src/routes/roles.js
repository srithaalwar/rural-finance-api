import { Router } from 'express'
import pool from '../config/db.js'

const router = Router()

router.get('/', async (req, res) => {
  const [roles] = await pool.query(`
    SELECT r.id, r.name, r.description, r.is_hq_role AS isHqRole,
           (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS userCount
    FROM roles r ORDER BY r.id
  `)
  const [perms] = await pool.query(
    'SELECT id, name, group_name AS groupName FROM permissions ORDER BY id'
  )
  const [links] = await pool.query(`
    SELECT rp.role_id AS roleId, p.name
    FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
  `)

  const groups = {}
  for (const p of perms) (groups[p.groupName] ||= []).push(p.name)

  const byRole = {}
  for (const l of links) (byRole[l.roleId] ||= []).push(l.name)

  res.json({
    groups,
    roles: roles.map((r) => ({ ...r, isHqRole: !!r.isHqRole, permissions: byRole[r.id] || [] })),
  })
})

router.put('/:id/permissions', async (req, res) => {
  const id = Number(req.params.id)
  const names = req.body.permissions
  if (!Array.isArray(names)) {
    return res.status(400).json({ message: 'permissions must be an array' })
  }

  const [[role]] = await pool.query('SELECT name FROM roles WHERE id = ?', [id])
  if (!role) return res.status(404).json({ message: 'Role not found' })
  if (role.name === 'Super Admin') {
    return res.status(403).json({ message: 'Super Admin permissions are locked' })
  }

  const [perms] = await pool.query(
    'SELECT id FROM permissions WHERE name IN (?)',
    [names.length ? names : ['']]
  )

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query('DELETE FROM role_permissions WHERE role_id = ?', [id])
    if (perms.length) {
      await conn.query(
        'INSERT INTO role_permissions (role_id, permission_id) VALUES ?',
        [perms.map((p) => [id, p.id])]
      )
    }
    await conn.commit()
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }

  res.json({ message: 'Permissions saved' })
})

export default router