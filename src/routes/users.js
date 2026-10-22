
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import pool from '../config/db.js'

const router = Router()
const DEFAULT_PASSWORD = 'Welcome@123'

const SELECT_USERS = `
  SELECT
    u.id,
    u.code,
    u.name,
    u.email,
    u.mobile,
    u.status,
    u.role_id AS roleId,
    u.branch_id AS branchId,
    r.name AS role,
    b.name AS branchName,
    CASE
      WHEN u.role_id IS NULL AND u.branch_id IS NULL THEN 'Unassigned'
      WHEN b.id IS NULL THEN 'Head Office'
      ELSE b.name
    END AS location
  FROM users u
  LEFT JOIN roles r ON r.id = u.role_id
  LEFT JOIN branches b ON b.id = u.branch_id
`

// GET /api/users
// Optional query parameters:
// ?role=Clerk
// ?branchId=1
// ?unassigned=true
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
        return res.status(400).json({
          message: 'Invalid branch ID',
        })
      }

      conditions.push('u.branch_id = ?')
      params.push(id)
    }

    if (unassigned === 'true') {
      conditions.push('u.role_id IS NULL')
      conditions.push('u.branch_id IS NULL')
    }

    const where = conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : ''

    const [rows] = await pool.query(
      `${SELECT_USERS} ${where} ORDER BY u.id DESC`,
      params
    )

    res.json(rows)
  } catch (error) {
    next(error)
  }
})

// POST /api/users
// Create a user without assigning a role or branch.
router.post('/', async (req, res, next) => {
  let connection

  try {
    const { name, email, mobile } = req.body

    if (!name?.trim() || !email?.trim()) {
      return res.status(400).json({
        message: 'Name and email are required',
      })
    }

    const normalizedEmail = email.trim().toLowerCase()
    const hash = await bcrypt.hash(DEFAULT_PASSWORD, 10)

    connection = await pool.getConnection()
    await connection.beginTransaction()

    const [existing] = await connection.query(
      'SELECT id FROM users WHERE email = ?',
      [normalizedEmail]
    )

    if (existing.length) {
      await connection.rollback()

      return res.status(409).json({
        message: 'A user with this email already exists',
      })
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

    await connection.query(
      'UPDATE users SET code = ? WHERE id = ?',
      [code, result.insertId]
    )

    await connection.commit()

    res.status(201).json({
      id: result.insertId,
      code,
      message: 'User created successfully. Role and branch are not assigned yet.',
    })
  } catch (error) {
    if (connection) {
      await connection.rollback()
    }

    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        message: 'A user with this email already exists',
      })
    }

    next(error)
  } finally {
    connection?.release()
  }
})

// PATCH /api/users/:id/assign
// Assign an existing user to a branch and a branch-level role.
router.patch('/:id/assign', async (req, res, next) => {
  let connection

  try {
    const userId = Number(req.params.id)
    const branchId = Number(req.body.branchId)
    const roleId = Number(req.body.roleId)

    if (
      !Number.isInteger(userId) || userId <= 0 ||
      !Number.isInteger(branchId) || branchId <= 0 ||
      !Number.isInteger(roleId) || roleId <= 0
    ) {
      return res.status(400).json({
        message: 'Valid user, branch and role IDs are required',
      })
    }

    connection = await pool.getConnection()
    await connection.beginTransaction()

    const [[user]] = await connection.query(
      `SELECT u.id, r.name AS currentRole
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?
       FOR UPDATE`,
      [userId]
    )

    if (!user) {
      await connection.rollback()
      return res.status(404).json({
        message: 'User not found',
      })
    }

    if (user.currentRole === 'Super Admin') {
      await connection.rollback()
      return res.status(403).json({
        message: 'Super Admin cannot be reassigned',
      })
    }

    const [[branch]] = await connection.query(
      'SELECT id FROM branches WHERE id = ?',
      [branchId]
    )

    if (!branch) {
      await connection.rollback()
      return res.status(404).json({
        message: 'Branch not found',
      })
    }

    const [[role]] = await connection.query(
      'SELECT id, name, is_hq_role FROM roles WHERE id = ?',
      [roleId]
    )

    if (!role) {
      await connection.rollback()
      return res.status(404).json({
        message: 'Role not found',
      })
    }

    if (role.name === 'Super Admin' || Boolean(role.is_hq_role)) {
      await connection.rollback()
      return res.status(400).json({
        message: 'Select a branch-level role for this branch',
      })
    }

    await connection.query(
      'UPDATE users SET role_id = ?, branch_id = ? WHERE id = ?',
      [roleId, branchId, userId]
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
      await connection.rollback()
    }

    next(error)
  } finally {
    connection?.release()
  }
})


/**
 * PATCH /api/users/:id/unassign
 * Remove a user from their current branch without deleting
 * their account. Clear both branch_id and role_id.
 */
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
      `SELECT u.id, u.branch_id AS branchId, r.name AS role
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?
       FOR UPDATE`,
      [userId]
    )

    if (!user) {
      await connection.rollback()
      return res.status(404).json({
        message: 'User not found',
      })
    }

    if (user.role === 'Super Admin') {
      await connection.rollback()
      return res.status(403).json({
        message: 'Super Admin cannot be unassigned',
      })
    }

    if (Number(user.branchId) !== branchId) {
      await connection.rollback()
      return res.status(409).json({
        message: 'User is not assigned to this branch',
      })
    }

    await connection.query(
      `UPDATE users
       SET branch_id = NULL, role_id = NULL
       WHERE id = ?`,
      [userId]
    )

    await connection.commit()

    res.json({
      message: 'User removed from branch and is now unassigned',
      userId,
      branchId,
    })
  } catch (error) {
    if (connection) {
      await connection.rollback()
    }

    next(error)
  } finally {
    connection?.release()
  }
})



/* PUT /api/users/:id
   Update contact details without changing role or branch. */
router.put('/:id', async (req, res, next) => {
  try {
    const userId = Number(req.params.id)
    const { name, email, mobile } = req.body

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        message: 'Invalid user ID',
      })
    }

    if (!name?.trim() || !email?.trim()) {
      return res.status(400).json({
        message: 'Name and email are required',
      })
    }

    const normalizedEmail = email.trim().toLowerCase()

    const [[user]] = await pool.query(
      `SELECT u.id, r.name AS role
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?`,
      [userId]
    )

    if (!user) {
      return res.status(404).json({
        message: 'User not found',
      })
    }

    if (user.role === 'Super Admin') {
      return res.status(403).json({
        message: 'Super Admin details cannot be edited here',
      })
    }

    const [result] = await pool.query(
      `UPDATE users
       SET name = ?, email = ?, mobile = ?
       WHERE id = ?`,
      [
        name.trim(),
        normalizedEmail,
        mobile?.trim() || null,
        userId,
      ]
    )

    res.json({
      message: 'User updated successfully',
      id: userId,
    })
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        message: 'Another user already has this email',
      })
    }

    next(error)
  }
})


/* DELETE /api/users/:id */
router.delete('/:id', async (req, res, next) => {
  try {
    const userId = Number(req.params.id)

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        message: 'Invalid user ID',
      })
    }

    const [[user]] = await pool.query(
      `SELECT u.id, r.name AS role
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?`,
      [userId]
    )

    if (!user) {
      return res.status(404).json({
        message: 'User not found',
      })
    }

    if (user.role === 'Super Admin') {
      return res.status(403).json({
        message: 'Super Admin cannot be deleted',
      })
    }

    await pool.query(
      'DELETE FROM users WHERE id = ?',
      [userId]
    )

    res.json({
      message: 'User deleted successfully',
      id: userId,
    })
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
      `SELECT u.id, u.status, r.name AS role
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?`,
      [req.params.id]
    )

    if (!user) {
      return res.status(404).json({
        message: 'User not found',
      })
    }

    if (user.role === 'Super Admin') {
      return res.status(403).json({
        message: 'Super Admin cannot be deactivated',
      })
    }

    const nextStatus =
      user.status === 'Active' ? 'Inactive' : 'Active'

    await pool.query(
      'UPDATE users SET status = ? WHERE id = ?',
      [nextStatus, user.id]
    )

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
