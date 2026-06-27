c = open('apps/web/src/app/client/page.tsx').read()

# Find }.slice(0, pageSize).map((item) => {
idx = c.index('}).slice(0, pageSize).map((item) => {')
# The .map takes a callback: (item) => {
# Find where this callback's return expression starts
callback_start = c.index('=> {', idx) + 4  # after =>
# Move past whitespace and newlines to find return value start
i = callback_start
while c[i] in ' \n\t': i += 1
# Count braces to find end of callback
brace_count = 0
start_i = i
while i < len(c):
    if c[i] == '{': brace_count += 1
    elif c[i] == '}': brace_count -= 1
    if brace_count == 0:
        break
    i += 1
# i is now at the closing } of the callback
print(f'Map starts at {idx}, ends at {i}')
print(f'First 100 chars: {c[idx:idx+100]}')
print(f'Last 100 chars: {c[i-100:i+1]}')

# Find the JSX div that the map returns
div_start = c.index('return (', idx)
# This is in the callback, the JSX starts after 'return ('
j = div_start + 8  # skip "return ("
while c[j] in ' \n': j += 1
print(f'JSX div starts at {j}: {c[j:j+30]}')

# Find corresponding </div>
# Count <div vs </div>
tag_count = 1
k = j + 1
while tag_count > 0 and k < len(c):
    if c[k:k+5] == '<div ' or c[k:k+5] == '<div>':
        tag_count += 1
        k += 5
    elif c[k:k+6] == '</div>':
        tag_count -= 1
        k += 6
    else:
        k += 1
jsx_end = k
print(f'JSX div ends at {jsx_end}: {c[jsx_end-20:jsx_end]}')

# The actual content to replace: from the first slice().map to its closing }) 
# Let me find the ) that closes the .map call
# After the callback's }, there should be )
after_cb = i + 1  # after }
while c[after_cb] in ' \n': after_cb += 1
if c[after_cb] == ')': after_cb += 1
print(f'.map closing at {after_cb}: {c[after_cb-5:after_cb+5]}')

rm find_markers.py 2>/dev/null
