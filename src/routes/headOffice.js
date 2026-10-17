import { Router } from 'express'
import pool from '../config/db.js'

const router = Router()

router.get('/', async (req, res) => {
  const [[office]] = await pool.query(
    `SELECT id, code, name, address, district, state, status,
            DATE_FORMAT(opened_on, '%d %b %Y') AS openedOn
     FROM head_office LIMIT 1`
  )
  const [team] = await pool.query(`
    SELECT u.id, u.code, u.name, u.email, r.name AS role
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.branch_id IS NULL ORDER BY u.id
  `)
  res.json({ office, team })
})

router.put('/', async (req, res) => {
  const { name, address, district, state } = req.body
  if (!name?.trim()) return res.status(400).json({ message: 'Name is required' })
  await pool.query(
    'UPDATE head_office SET name = ?, address = ?, district = ?, state = ? LIMIT 1',
    [name.trim(), address || null, district || null, state || null]
  )
  res.json({ message: 'Head Office updated' })
})

export default router