-- Golden 1 labels moves between your own accounts "G1 ONLINE TRANSFER", cut
-- to "G1 ONLINE TR", "G1 ONLINE LV1 TRAN" and so on by the 32-character OFX
-- name limit. They are money moving, not spending or income, and must not be
-- read as a subscription or a paycheck. Outranks the seeded rules (100).
INSERT INTO category_rules (category_id, match_type, pattern, priority)
SELECT c.id, 'contains', 'G1 ONLINE', 300
FROM categories c
WHERE c.name = 'Transfer'
ON CONFLICT (category_id, match_type, pattern) DO NOTHING;
