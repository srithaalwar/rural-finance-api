
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

// POST /api/roles
// Create a role and save its selected permissions.
// Role location is not required from the frontend.
router.post('/', async (req, res, next) => {
  const {
    name,
    description = '',
    permissions = [],
  } = req.body

  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({
      message: 'Role name is required',
    })
  }

  if (typeof description !== 'string') {
    return res.status(400).json({
      message: 'Description must be a string',
    })
  }

  if (
    !Array.isArray(permissions) ||
    !permissions.every((p) => typeof p === 'string')
  ) {
    return res.status(400).json({
      message: 'Permissions must be an array of names',
    })
  }

  let connection

  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()

    const uniquePermissions = [...new Set(permissions)]
    let permissionRows = []

    if (uniquePermissions.length > 0) {
      const [rows] = await connection.query(
        'SELECT id, name FROM permissions WHERE name IN (?)',
        [uniquePermissions]
      )

      permissionRows = rows

      const foundNames = new Set(
        rows.map((permission) => permission.name)
      )

      const invalidPermissions = uniquePermissions.filter(
        (permission) => !foundNames.has(permission)
      )

      if (invalidPermissions.length > 0) {
        await connection.rollback()

        return res.status(400).json({
          message: 'Some selected permissions do not exist',
          invalidPermissions,
        })
      }
    }

    // Keep the existing database column.
    // New roles default to Branch (0).
    const [result] = await connection.query(
      `INSERT INTO roles (name, description, is_hq_role)
       VALUES (?, ?, ?)`,
      [name.trim(), description.trim(), 0]
    )

    const roleId = result.insertId

    // Save selected permissions immediately.
    if (permissionRows.length > 0) {
      await connection.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ?`,
        [
          permissionRows.map((permission) => [
            roleId,
            permission.id,
          ]),
        ]
      )
    }

    await connection.commit()

    return res.status(201).json({
      message: 'Role and permissions created successfully',
      role: {
        id: roleId,
        name: name.trim(),
        description: description.trim(),
        permissions: permissionRows.map(
          (permission) => permission.name
        ),
      },
    })
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback()
      } catch (rollbackError) {
        console.error(
          'Role creation rollback failed:',
          rollbackError.message
        )
      }
    }

    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        message: 'A role with this name already exists',
      })
    }

    console.error('Create role error:', error)
    return next(error)
  } finally {
    connection?.release()
  }
})


// PUT /api/roles/:id
// Update a role's name, description, and location.
// PUT /api/roles/:id
// Update role details and permissions.
// Existing role location is preserved.
router.put('/:id', async (req, res, next) => {
  const id = Number(req.params.id)
  const { name, description, permissions } = req.body

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({
      message: 'Invalid role ID',
    })
  }

  if (
    typeof name !== 'string' ||
    !name.trim() ||
    typeof description !== 'string' ||
    !Array.isArray(permissions) ||
    !permissions.every((p) => typeof p === 'string')
  ) {
    return res.status(400).json({
      message: 'Valid name, description, and permissions are required',
    })
  }

  let connection

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
        message: 'Super Admin cannot be modified',
      })
    }

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

    const uniquePermissions = [...new Set(permissions)]
    let permissionRows = []

    if (uniquePermissions.length > 0) {
      const [rows] = await connection.query(
        'SELECT id, name FROM permissions WHERE name IN (?)',
        [uniquePermissions]
      )

      permissionRows = rows

      const foundNames = new Set(
        rows.map((permission) => permission.name)
      )

      const invalidPermissions = uniquePermissions.filter(
        (permission) => !foundNames.has(permission)
      )

      if (invalidPermissions.length > 0) {
        await connection.rollback()

        return res.status(400).json({
          message: 'Some selected permissions do not exist',
          invalidPermissions,
        })
      }
    }

    // Update only name and description.
    // is_hq_role remains unchanged in the database.
    await connection.query(
      `UPDATE roles
       SET name = ?, description = ?
       WHERE id = ?`,
      [name.trim(), description.trim(), id]
    )

    // Replace the role's previous permissions.
    await connection.query(
      'DELETE FROM role_permissions WHERE role_id = ?',
      [id]
    )

    if (permissionRows.length > 0) {
      await connection.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ?`,
        [
          permissionRows.map((permission) => [
            id,
            permission.id,
          ]),
        ]
      )
    }

    await connection.commit()

    return res.json({
      message: 'Role and permissions updated successfully',
      role: {
        id,
        name: name.trim(),
        description: description.trim(),
        permissions: permissionRows.map(
          (permission) => permission.name
        ),
      },
    })
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback()
      } catch (rollbackError) {
        console.error(
          'Role update rollback failed:',
          rollbackError.message
        )
      }
    }

    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        message: 'A role with this name already exists',
      })
    }

    console.error('Update role error:', error)
    return next(error)
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


// PUT /api/roles/:id/permissionsa
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
