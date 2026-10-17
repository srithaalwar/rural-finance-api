import { Router } from 'express'
import pool from '../config/db.js'

const router = Router()

router.get('/', async (req, res) => {
  const [[counts]] = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM branches) AS branches,
      (SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'Admin') AS admins,
      (SELECT COUNT(*) FROM users) AS totalStaff,
      (SELECT COUNT(*) FROM users WHERE status = 'Active') AS activeStaff
  `)

  const [staffByRole] = await pool.query(`
    SELECT r.name AS role, COUNT(u.id) AS count
    FROM roles r LEFT JOIN users u ON u.role_id = r.id
    GROUP BY r.id ORDER BY r.id
  `)

  const [branches] = await pool.query(`
    SELECT b.name,
      (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id) AS staff,
      (SELECT u.name FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.branch_id = b.id AND r.name = 'Branch Manager' LIMIT 1) AS manager
    FROM branches b ORDER BY b.id
  `)

  const [recent] = await pool.query(`
    SELECT u.name, u.status, r.name AS role, COALESCE(b.name, 'Head Office') AS location
    FROM users u JOIN roles r ON r.id = u.role_id
    LEFT JOIN branches b ON b.id = u.branch_id
    ORDER BY u.id DESC LIMIT 4
  `)

  res.json({ counts, staffByRole, branches, recent })
})

export default router