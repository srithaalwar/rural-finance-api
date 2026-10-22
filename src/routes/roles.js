
import { Router } from 'express'
import pool from '../config/db.js'

const router = Router()

// GET /api/roles
// Fetch all saved roles, permissions, and user counts.
router.get('/', async (req, res) => {
  const [roles] = await pool.query(`
    SELECT
      r.id,
      r.name,
      r.description,
      r.is_hq_role AS isHqRole,
      (
        SELECT COUNT(*)
        FROM users u
        WHERE u.role_id = r.id
      ) AS userCount
    FROM roles r
    ORDER BY r.id DESC
  `)

  const [perms] = await pool.query(`
    SELECT id, name, group_name AS groupName
    FROM permissions
    ORDER BY id
  `)

  const [links] = await pool.query(`
    SELECT rp.role_id AS roleId, p.name
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
  `)

  const groups = {}

  for (const p of perms) {
    ;(groups[p.groupName] ||= []).push(p.name)
  }

  const byRole = {}

  for (const link of links) {
    ;(byRole[link.roleId] ||= []).push(link.name)
  }

  res.json({
    groups,
    roles: roles.map((role) => ({
      ...role,
      isHqRole: Boolean(role.isHqRole),
      userCount: Number(role.userCount),
      permissions: byRole[role.id] || [],
    })),
  })
})

// POST /api/roles
// Create a new role.
router.post('/', async (req, res) => {
  const {
    name,
    description = '',
    isHqRole = false,
  } = req.body

  if (!name?.trim()) {
    return res.status(400).json({
      message: 'Role name is required',
    })
  }

  if (typeof isHqRole !== 'boolean') {
    return res.status(400).json({
      message: 'isHqRole must be true or false',
    })
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO roles (name, description, is_hq_role)
       VALUES (?, ?, ?)`,
      [name.trim(), description.trim(), isHqRole ? 1 : 0]
    )

    res.status(201).json({
      message: 'Role created successfully',
      role: {
        id: result.insertId,
        name: name.trim(),
        description: description.trim(),
        isHqRole,
        userCount: 0,
        permissions: [],
      },
    })
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        message: 'A role with this name already exists',
      })
    }

    console.error('Create role error:', error)

    res.status(500).json({
      message: 'Failed to create role',
    })
  }
})

// PUT /api/roles/:id
// Update a role's name, description, and location.
router.put('/:id', async (req, res, next) => {
  const id = Number(req.params.id)
  const { name, description, isHqRole } = req.body

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({
      message: 'Invalid role ID',
    })
  }

  if (
    typeof name !== 'string' ||
    !name.trim() ||
    typeof description !== 'string' ||
    typeof isHqRole !== 'boolean'
  ) {
    return res.status(400).json({
      message: 'Valid name, description, and isHqRole are required',
    })
  }

  let connection

  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()

    const [[role]] = await connection.query(
      `SELECT id, name, is_hq_role AS isHqRole
       FROM roles
       WHERE id = ?
       FOR UPDATE`,
      [id]
    )

    if (!role) {
      await connection.rollback()
      return res.status(404).json({
        message: 'Role not found',
      })
    }

    // Protect the Super Admin role name and location.
    if (
      role.name === 'Super Admin' &&
      (
        name.trim() !== role.name ||
        isHqRole !== Boolean(role.isHqRole)
      )
    ) {
      await connection.rollback()
      return res.status(403).json({
        message: 'Super Admin name and location cannot be changed',
      })
    }

    // Prevent duplicate names.
    const [[duplicate]] = await connection.query(
      'SELECT id FROM roles WHERE name = ? AND id <> ?',
      [name.trim(), id]
    )

    if (duplicate) {
      await connection.rollback()
      return res.status(409).json({
        message: 'A role with this name already exists',
      })
    }

    // Do not change location while users are assigned to the role.
    if (
      isHqRole !== Boolean(role.isHqRole)
    ) {
      const [[usage]] = await connection.query(
        'SELECT COUNT(*) AS total FROM users WHERE role_id = ?',
        [id]
      )

      if (Number(usage.total) > 0) {
        await connection.rollback()
        return res.status(409).json({
          message:
            'This role has assigned users. Reassign them before changing its location.',
        })
      }
    }

    await connection.query(
      `UPDATE roles
       SET name = ?, description = ?, is_hq_role = ?
       WHERE id = ?`,
      [name.trim(), description.trim(), isHqRole ? 1 : 0, id]
    )

    await connection.commit()

    res.json({
      message: 'Role updated successfully',
      role: {
        id,
        name: name.trim(),
        description: description.trim(),
        isHqRole,
      },
    })
  } catch (error) {
    if (connection) await connection.rollback()

    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        message: 'A role with this name already exists',
      })
    }

    next(error)
  } finally {
    connection?.release()
  }
})

// DELETE /api/roles/:id
// Delete a role only if no users are assigned to it.
router.delete('/:id', async (req, res, next) => {
  const id = Number(req.params.id)
  let connection

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({
      message: 'Invalid role ID',
    })
  }

  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()

    const [[role]] = await connection.query(
      `SELECT id, name
       FROM roles
       WHERE id = ?
       FOR UPDATE`,
      [id]
    )

    if (!role) {
      await connection.rollback()
      return res.status(404).json({
        message: 'Role not found',
      })
    }

    if (role.name === 'Super Admin') {
      await connection.rollback()
      return res.status(403).json({
        message: 'Super Admin cannot be deleted',
      })
    }

    const [[usage]] = await connection.query(
      'SELECT COUNT(*) AS total FROM users WHERE role_id = ?',
      [id]
    )

    if (Number(usage.total) > 0) {
      await connection.rollback()
      return res.status(409).json({
        message:
          `Cannot delete this role because ${usage.total} user(s) are assigned to it. Reassign those users first.`,
      })
    }

    // Remove the role's permission mappings first.
    await connection.query(
      'DELETE FROM role_permissions WHERE role_id = ?',
      [id]
    )

    await connection.query(
      'DELETE FROM roles WHERE id = ?',
      [id]
    )

    await connection.commit()

    res.json({
      message: 'Role deleted successfully',
      id,
    })
  } catch (error) {
    if (connection) await connection.rollback()

    // Another table may reference this role.
    if (error.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({
        message:
          'This role is referenced by other records and cannot be deleted yet.',
      })
    }

    next(error)
  } finally {
    connection?.release()
  }
})


// PUT /api/roles/:id/permissions
// Update permissions assigned to a role.
router.put('/:id/permissions', async (req, res) => {
  const id = Number(req.params.id)
  const names = req.body.permissions

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({
      message: 'Invalid role ID',
    })
  }

  if (!Array.isArray(names)) {
    return res.status(400).json({
      message: 'permissions must be an array',
    })
  }

  const [[role]] = await pool.query(
    'SELECT name FROM roles WHERE id = ?',
    [id]
  )

  if (!role) {
    return res.status(404).json({
      message: 'Role not found',
    })
  }

  if (role.name === 'Super Admin') {
    return res.status(403).json({
      message: 'Super Admin permissions are locked',
    })
  }

  const [perms] = await pool.query(
    'SELECT id FROM permissions WHERE name IN (?)',
    [names.length ? [...new Set(names)] : ['']]
  )

  const conn = await pool.getConnection()

  try {
    await conn.beginTransaction()

    await conn.query(
      'DELETE FROM role_permissions WHERE role_id = ?',
      [id]
    )

    if (perms.length) {
      await conn.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ?`,
        [perms.map((perm) => [id, perm.id])]
      )
    }

    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }

  res.json({
    message: 'Permissions saved',
  })
})

export default router
