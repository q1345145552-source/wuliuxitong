c = open('apps/web/src/app/client/page.tsx').read()

# Find the first card section - use unique className or comment as marker
# The card section starts with a filter and then maps
marker1 = '{(pageData.length === 0 ? dataItems : pageData).map((item: any) => {'
idx1 = c.find(marker1)
marker2 = '{(pageData.length === 0 ? prealertItems : pageData).map((item: any) => {'
idx2 = c.find(marker2)

print(f'Section 1 at {idx1}')
print(f'Section 2 at {idx2}')

# For section 1, find the matching closing )}
# Count braces from the map opening
if idx1 > 0:
    brace_count = 0
    i = idx1 + len(marker1)
    # Find the opening {
    i = c.index('{', i)  # skip past the opening brace
    brace_count = 1
    while brace_count > 0 and i < len(c):
        i += 1
        if c[i] == '{': brace_count += 1
        elif c[i] == '}': brace_count -= 1
    # i is now at the } of the .map callback
    # Find the closing )} of .map(
    while c[i] != ')': i += 1
    i += 1  # skip )
    if c[i] == '}': i += 1  # skip }
    section1_end = i
    print(f'Section 1 ends at {section1_end}')
    print(f'Content: {c[idx1:idx1+200]}')
