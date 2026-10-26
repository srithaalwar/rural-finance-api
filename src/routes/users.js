import { Router } from 'express'
import bcrypt from 'bcryptjs'
import pool from '../config/db.js'

const router = Router()

const SELECT_USERS = `
  SELECT
    u.id,
    u.code,
    u.name,
    u.email,
    u.mobile,
    u.status,
    u.role_id AS roleId,
    r.name AS role,
    (SELECT GROUP_CONCAT(DISTINCT ubr.branch_id)
       FROM user_branch_roles ubr WHERE ubr.user_id = u.id) AS branchIdsCsv,
    (SELECT GROUP_CONCAT(DISTINCT ubr.role_id)
       FROM user_branch_roles ubr WHERE ubr.user_id = u.id) AS roleIdsCsv,
    (SELECT GROUP_CONCAT(CONCAT(ubr.branch_id, ':', ubr.role_id))
       FROM user_branch_roles ubr WHERE ubr.user_id = u.id) AS membershipsCsv,
    (SELECT GROUP_CONCAT(DISTINCT r2.name ORDER BY r2.name SEPARATOR ', ')
       FROM user_branch_roles ubr2
       JOIN roles r2 ON r2.id = ubr2.role_id
      WHERE ubr2.user_id = u.id) AS roleNames,
    (SELECT GROUP_CONCAT(DISTINCT b2.name ORDER BY b2.name SEPARATOR ', ')
       FROM user_branch_roles ubr3
       JOIN branches b2 ON b2.id = ubr3.branch_id
      WHERE ubr3.user_id = u.id) AS branchNames,
    CASE
      WHEN u.role_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM user_branch_roles ubr4 WHERE ubr4.user_id = u.id)
        THEN 'Head Office'
      WHEN NOT EXISTS (SELECT 1 FROM user_branch_roles ubr5 WHERE ubr5.user_id = u.id)
        THEN 'Unassigned'
      ELSE NULL
    END AS location
  FROM users u
  LEFT JOIN roles r ON r.id = u.role_id
`

// GET /api/users
router.get('/', async (req, res, next) => {
  try {
    const { role, branchId, unassigned } = req.query
    const conditions = []
    const params = []

    if (role) {
      conditions.push('r.name = ?')
      params.push(role)
    }

    if (branchId !== undefined) {
      const id = Number(branchId)

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ message: 'Invalid branch ID' })
      }

      conditions.push(
        'EXISTS (SELECT 1 FROM user_branch_roles ubr WHERE ubr.user_id = u.id AND ubr.branch_id = ?)'
      )
      params.push(id)
    }

    if (unassigned === 'true') {
      conditions.push('u.role_id IS NULL')
      conditions.push(
        'NOT EXISTS (SELECT 1 FROM user_branch_roles ubr WHERE ubr.user_id = u.id)'
      )
    }

    const where = conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : ''

    const [rows] = await pool.query(
      `${SELECT_USERS} ${where} ORDER BY u.id DESC`,
      params
    )

    const result = rows.map(
      ({
        branchIdsCsv,
        roleIdsCsv,
        membershipsCsv,
        roleNames,
        branchNames,
        ...u
      }) => {
        const branchIds = branchIdsCsv
          ? branchIdsCsv.split(',').map(Number).filter((n) => !Number.isNaN(n))
          : []
        const roleIds = roleIdsCsv
          ? roleIdsCsv.split(',').map(Number).filter((n) => !Number.isNaN(n))
          : u.roleId
            ? [u.roleId]
            : []

        const branchRoleMap = {}
        if (membershipsCsv) {
          for (const pair of membershipsCsv.split(',')) {
            const [b, rId] = pair.split(':').map(Number)
            if (Number.isNaN(b) || Number.isNaN(rId)) continue
            if (!branchRoleMap[b]) branchRoleMap[b] = []
            if (!branchRoleMap[b].includes(rId)) branchRoleMap[b].push(rId)
          }
        }

        return {
          ...u,
          branchIds,
          roleIds,
          branchRoleMap,
          role: roleNames || u.role || null,
          branchName: branchNames || null,
        }
      }
    )

    res.json(result)
  } catch (error) {
    next(error)
  }
})

// POST /api/users
router.post('/', async (req, res, next) => {
  let connection

  try {
    const { name, email, mobile, password, confirmPassword } = req.body

    if (!name?.trim() || !email?.trim() || !password) {
      return res
        .status(400)
        .json({ message: 'Name, email and password are required' })
    }

    if (password.length < 8) {
      return res
        .status(400)
        .json({ message: 'Password must contain at least 8 characters' })
    }

    if (password !== confirmPassword) {
      return res
        .status(400)
        .json({ message: 'Password and confirm password do not match' })
    }

    const normalizedEmail = email.trim().toLowerCase()
    const hash = await bcrypt.hash(password, 10)

    connection = await pool.getConnection()
    await connection.beginTransaction()

    const [existing] = await connection.query(
      'SELECT id FROM users WHERE email = ?',
      [normalizedEmail]
    )

    if (existing.length > 0) {
      await connection.rollback()
      return res
        .status(409)
        .json({ message: 'A user with this email already exists' })
    }

    const [result] = await connection.query(
      `INSERT INTO users
        (code, name, email, mobile, password_hash, role_id, branch_id)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      [
        `TMP${Date.now()}`,
        name.trim(),
        normalizedEmail,
        mobile?.trim() || null,
        hash,
      ]
    )

    const code = `U-${String(result.insertId).padStart(3, '0')}`

    await connection.query('UPDATE users SET code = ? WHERE id = ?', [
      code,
      result.insertId,
    ])

    await connection.commit()

    return res.status(201).json({
      id: result.insertId,
      code,
      message:
        'User created successfully. Role and branch are not assigned yet.',
    })
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback()
      } catch (rollbackError) {
        console.error(
          'Transaction rollback failed:',
          rollbackError.message
        )
      }
    }

    console.error('CREATE USER FAILED:', {
      code: error.code,
      message: error.message,
      sqlMessage: error.sqlMessage,
    })

    if (error.code === 'ER_DUP_ENTRY') {
      return res
        .status(409)
        .json({ message: 'A user with this email or code already exists' })
    }

    return next(error)
  } finally {
    connection?.release()
  }
})

/* PUT /api/users/branch/:branchId/members */
router.put('/branch/:branchId/members', async (req, res, next) => {
  let connection

  try {
    const branchId = Number(req.params.branchId)
    const members = Array.isArray(req.body.members) ? req.body.members : []

    if (!Number.isInteger(branchId) || branchId <= 0) {
      return res.status(400).json({ message: 'Invalid branch ID' })
    }

    const wanted = new Map()

    for (const m of members) {
      const userId = Number(m.userId)
      const roleIds = [
        ...new Set((Array.isArray(m.roleIds) ? m.roleIds : []).map(Number)),
      ]

      if (
        !Number.isInteger(userId) ||
        userId <= 0 ||
        roleIds.length === 0 ||
        roleIds.some((r) => !Number.isInteger(r) || r <= 0)
      ) {
        return res
          .status(400)
          .json({ message: 'Every selected user needs at least one role' })
      }

      wanted.set(userId, roleIds)
    }

    connection = await pool.getConnection()
    await connection.beginTransaction()

    const [[branch]] = await connection.query(
      'SELECT id FROM branches WHERE id = ?',
      [branchId]
    )

    if (!branch) {
      await connection.rollback()
      return res.status(404).json({ message: 'Branch not found' })
    }

    const allRoleIds = [...new Set([...wanted.values()].flat())]

    if (allRoleIds.length > 0) {
      const [roleRows] = await connection.query(
        'SELECT id, name, is_hq_role FROM roles WHERE id IN (?)',
        [allRoleIds]
      )

      if (roleRows.length !== allRoleIds.length) {
        await connection.rollback()
        return res.status(404).json({ message: 'One or more roles not found' })
      }

      if (
        roleRows.some(
          (r) => r.name === 'Super Admin' || Boolean(r.is_hq_role)
        )
      ) {
        await connection.rollback()
        return res
          .status(400)
          .json({ message: 'Select branch-level roles only' })
      }
    }

    const [current] = await connection.query(
      'SELECT DISTINCT user_id FROM user_branch_roles WHERE branch_id = ? FOR UPDATE',
      [branchId]
    )
    const currentIds = new Set(current.map((r) => Number(r.user_id)))

    for (const userId of wanted.keys()) {
      const [[u]] = await connection.query(
        `SELECT u.id, u.name, u.status
           FROM users u
          WHERE u.id = ?
          FOR UPDATE`,
        [userId]
      )

      if (!u) {
        await connection.rollback()
        return res.status(404).json({ message: `User ${userId} not found` })
      }

      // NOTE: HQ users are intentionally allowed to be branch members now.
      // Only inactive users are blocked.

      if (u.status !== 'Active') {
        await connection.rollback()
        return res
          .status(400)
          .json({ message: `${u.name} is inactive` })
      }
    }

    let removed = 0

    for (const userId of currentIds) {
      if (wanted.has(userId)) continue

      await connection.query(
        'DELETE FROM user_branch_roles WHERE branch_id = ? AND user_id = ?',
        [branchId, userId]
      )
      removed += 1
    }

    for (const [userId, roleIds] of wanted) {
      await connection.query(
        'DELETE FROM user_branch_roles WHERE branch_id = ? AND user_id = ?',
        [branchId, userId]
      )
      await connection.query(
        'INSERT INTO user_branch_roles (branch_id, user_id, role_id) VALUES ?',
        [roleIds.map((roleId) => [branchId, userId, roleId])]
      )
    }

    await connection.commit()

    res.json({
      message: `Branch users saved (${wanted.size} assigned, ${removed} removed)`,
      branchId,
    })
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback()
      } catch {
        /* ignore */
      }
    }

    next(error)
  } finally {
    connection?.release()
  }
})

// PATCH /api/users/:id/assign
router.patch('/:id/assign', async (req, res, next) => {
  let connection

  try {
    const userId = Number(req.params.id)
    const branchId = Number(req.body.branchId)
    const roleId = Number(req.body.roleId)

    if (
      !Number.isInteger(userId) ||
      userId <= 0 ||
      !Number.isInteger(branchId) ||
      branchId <= 0 ||
      !Number.isInteger(roleId) ||
      roleId <= 0
    ) {
      return res.status(400).json({
        message: 'Valid user, branch and role IDs are required',
      })
    }

    connection = await pool.getConnection()
    await connection.beginTransaction()

    const [[user]] = await connection.query(
      `SELECT u.id,
              EXISTS (
                SELECT 1 FROM user_branch_roles ubr
                  JOIN roles r2 ON r2.id = ubr.role_id
                 WHERE ubr.user_id = u.id AND r2.name = 'Super Admin'
              ) OR EXISTS (
                SELECT 1 FROM roles r3
                 WHERE r3.id = u.role_id AND r3.name = 'Super Admin'
              ) AS isSuperAdmin
         FROM users u
        WHERE u.id = ?
        FOR UPDATE`,
      [userId]
    )

    if (!user) {
      await connection.rollback()
      return res.status(404).json({ message: 'User not found' })
    }

    if (user.isSuperAdmin) {
      await connection.rollback()
      return res
        .status(403)
        .json({ message: 'Super Admin cannot be reassigned' })
    }

    const [[branch]] = await connection.query(
      'SELECT id FROM branches WHERE id = ?',
      [branchId]
    )

    if (!branch) {
      await connection.rollback()
      return res.status(404).json({ message: 'Branch not found' })
    }

    const [[role]] = await connection.query(
      'SELECT id, name, is_hq_role FROM roles WHERE id = ?',
      [roleId]
    )

    if (!role) {
      await connection.rollback()
      return res.status(404).json({ message: 'Role not found' })
    }

    if (role.name === 'Super Admin' || Boolean(role.is_hq_role)) {
      await connection.rollback()
      return res
        .status(400)
        .json({ message: 'Select a branch-level role for this branch' })
    }

    await connection.query(
      'DELETE FROM user_branch_roles WHERE branch_id = ? AND user_id = ?',
      [branchId, userId]
    )
    await connection.query(
      'INSERT INTO user_branch_roles (branch_id, user_id, role_id) VALUES (?, ?, ?)',
      [branchId, userId, roleId]
    )

    await connection.commit()

    res.json({
      message: 'User assigned to branch successfully',
      userId,
      branchId,
      roleId,
    })
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback()
      } catch {
        /* ignore */
      }
    }

    next(error)
  } finally {
    connection?.release()
  }
})

// PATCH /api/users/:id/unassign
router.patch('/:id/unassign', async (req, res, next) => {
  let connection

  try {
    const userId = Number(req.params.id)
    const branchId = Number(req.body.branchId)

    if (
      !Number.isInteger(userId) ||
      userId <= 0 ||
      !Number.isInteger(branchId) ||
      branchId <= 0
    ) {
      return res.status(400).json({
        message: 'Valid user ID and branch ID are required',
      })
    }

    connection = await pool.getConnection()
    await connection.beginTransaction()

    const [[user]] = await connection.query(
      `SELECT u.id,
              EXISTS (
                SELECT 1 FROM user_branch_roles ubr
                  JOIN roles r2 ON r2.id = ubr.role_id
                 WHERE ubr.user_id = u.id AND r2.name = 'Super Admin'
              ) OR EXISTS (
                SELECT 1 FROM roles r3
                 WHERE r3.id = u.role_id AND r3.name = 'Super Admin'
              ) AS isSuperAdmin
         FROM users u
        WHERE u.id = ?
        FOR UPDATE`,
      [userId]
    )

    if (!user) {
      await connection.rollback()
      return res.status(404).json({ message: 'User not found' })
    }

    if (user.isSuperAdmin) {
      await connection.rollback()
      return res
        .status(403)
        .json({ message: 'Super Admin cannot be unassigned' })
    }

    const [[membership]] = await connection.query(
      'SELECT 1 FROM user_branch_roles WHERE user_id = ? AND branch_id = ? LIMIT 1',
      [userId, branchId]
    )

    if (!membership) {
      await connection.rollback()
      return res
        .status(409)
        .json({ message: 'User is not assigned to this branch' })
    }

    await connection.query(
      'DELETE FROM user_branch_roles WHERE user_id = ? AND branch_id = ?',
      [userId, branchId]
    )

    await connection.commit()

    res.json({
      message: 'User removed from this branch',
      userId,
      branchId,
    })
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback()
      } catch {
        /* ignore */
      }
    }

    next(error)
  } finally {
    connection?.release()
  }
})

/* PUT /api/users/:id */
router.put('/:id', async (req, res, next) => {
  try {
    const userId = Number(req.params.id)
    const { name, email, mobile, password, confirmPassword } = req.body

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: 'Invalid user ID' })
    }

    if (!name?.trim() || !email?.trim()) {
      return res
        .status(400)
        .json({ message: 'Name and email are required' })
    }

    const changingPassword = Boolean(password)

    if (changingPassword) {
      if (password.length < 8) {
        return res
          .status(400)
          .json({ message: 'Password must contain at least 8 characters' })
      }

      if (password !== confirmPassword) {
        return res
          .status(400)
          .json({ message: 'Password and confirm password do not match' })
      }
    }

    const normalizedEmail = email.trim().toLowerCase()

    const [[user]] = await pool.query(
      `SELECT u.id,
              EXISTS (
                SELECT 1 FROM user_branch_roles ubr
                  JOIN roles r2 ON r2.id = ubr.role_id
                 WHERE ubr.user_id = u.id AND r2.name = 'Super Admin'
              ) OR EXISTS (
                SELECT 1 FROM roles r3
                 WHERE r3.id = u.role_id AND r3.name = 'Super Admin'
              ) AS isSuperAdmin
         FROM users u
        WHERE u.id = ?`,
      [userId]
    )

    if (!user) {
      return res.status(404).json({ message: 'User not found' })
    }

    if (user.isSuperAdmin) {
      return res
        .status(403)
        .json({ message: 'Super Admin details cannot be edited here' })
    }

    if (changingPassword) {
      const hash = await bcrypt.hash(password, 10)

      await pool.query(
        `UPDATE users
            SET name = ?, email = ?, mobile = ?, password_hash = ?
          WHERE id = ?`,
        [
          name.trim(),
          normalizedEmail,
          mobile?.trim() || null,
          hash,
          userId,
        ]
      )
    } else {
      await pool.query(
        `UPDATE users
            SET name = ?, email = ?, mobile = ?
          WHERE id = ?`,
        [name.trim(), normalizedEmail, mobile?.trim() || null, userId]
      )
    }

    res.json({
      message: changingPassword
        ? 'User and password updated successfully'
        : 'User updated successfully',
      id: userId,
    })
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res
        .status(409)
        .json({ message: 'Another user already has this email' })
    }

    next(error)
  }
})

/* DELETE /api/users/:id */
router.delete('/:id', async (req, res, next) => {
  try {
    const userId = Number(req.params.id)

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: 'Invalid user ID' })
    }

    const [[user]] = await pool.query(
      `SELECT u.id,
              EXISTS (
                SELECT 1 FROM user_branch_roles ubr
                  JOIN roles r2 ON r2.id = ubr.role_id
                 WHERE ubr.user_id = u.id AND r2.name = 'Super Admin'
              ) OR EXISTS (
                SELECT 1 FROM roles r3
                 WHERE r3.id = u.role_id AND r3.name = 'Super Admin'
              ) AS isSuperAdmin
         FROM users u
        WHERE u.id = ?`,
      [userId]
    )

    if (!user) {
      return res.status(404).json({ message: 'User not found' })
    }

    if (user.isSuperAdmin) {
      return res
        .status(403)
        .json({ message: 'Super Admin cannot be deleted' })
    }

    await pool.query('DELETE FROM users WHERE id = ?', [userId])

    res.json({ message: 'User deleted successfully', id: userId })
  } catch (error) {
    if (
      error.code === 'ER_ROW_IS_REFERENCED_2' ||
      error.code === 'ER_NO_REFERENCED_ROW_2'
    ) {
      return res.status(409).json({
        message:
          'This user is linked to other records and cannot be deleted. Deactivate the user instead.',
      })
    }

    next(error)
  }
})

// PATCH /api/users/:id/toggle
router.patch('/:id/toggle', async (req, res, next) => {
  try {
    const [[user]] = await pool.query(
      `SELECT u.id, u.status,
              EXISTS (
                SELECT 1 FROM user_branch_roles ubr
                  JOIN roles r2 ON r2.id = ubr.role_id
                 WHERE ubr.user_id = u.id AND r2.name = 'Super Admin'
              ) OR EXISTS (
                SELECT 1 FROM roles r3
                 WHERE r3.id = u.role_id AND r3.name = 'Super Admin'
              ) AS isSuperAdmin
         FROM users u
        WHERE u.id = ?`,
      [req.params.id]
    )

    if (!user) {
      return res.status(404).json({ message: 'User not found' })
    }

    if (user.isSuperAdmin) {
      return res
        .status(403)
        .json({ message: 'Super Admin cannot be deactivated' })
    }

    const nextStatus = user.status === 'Active' ? 'Inactive' : 'Active'

    await pool.query('UPDATE users SET status = ? WHERE id = ?', [
      nextStatus,
      user.id,
    ])

    res.json({
      id: user.id,
      status: nextStatus,
      message: `User ${nextStatus.toLowerCase()} successfully`,
    })
  } catch (error) {
    next(error)
  }
})

export default router