lines = open('apps/web/src/app/client/page.tsx').readlines()
chunk = open('table_chunk.txt').read()

# Section 1: lines 714-784 → replace with chunk
new_lines = lines[:713] + [chunk + '\n'] + ['          )}\n'] + lines[785:]

# Section 2: find and replace the second card section (around lines 1383-1456)
# The second section starts with same pattern but earlier line numbers shifted
s = ''.join(new_lines)
old_pattern = '<div style={{ display: "grid", gap: 8 }}>'
# Find second occurrence
idx1 = s.index(old_pattern)
idx2 = s.index(old_pattern, idx1 + 1)
print(f'Second grid at index {idx2}')

# Find matching </div>
tag_depth = 1
i = idx2 + len(old_pattern)
while tag_depth > 0 and i < len(s):
    no = s.find('<div', i)
    nc = s.find('</div>', i)
    if no >= 0 and (nc < 0 or no < nc):
        tag_depth += 1
        i = no + 4
    elif nc >= 0:
        tag_depth -= 1
        i = nc + 6
    else:
        break
div_end = i
after = s.find(')}', div_end)
section2_end = after + 2
print(f'Section 2 ends at {section2_end}')

s = s[:idx2] + chunk + '\n          )}\n' + s[section2_end:]
open('apps/web/src/app/client/page.tsx', 'w').write(s)
print('Both sections replaced')
