"""Reusable React browser checks for CHROMA's project and library workflows.

Called with the CDP Browser helper from check_chroma.py in an isolated browser;
checks that deleting a project keeps its saved colours in the library.
"""
import json


def check_collections(browser):
    def click_text(label):
        expression = "Array.from(document.querySelectorAll('button')).find(e => e.textContent.trim() === " + json.dumps(label) + ")"
        browser.wait(expression)
        browser.evaluate(expression + ".click()")

    def fill(selector, value):
        browser.fill(selector, value)

    browser.evaluate("location.hash = 'projects'")
    click_text('New project')
    browser.wait("document.querySelector('#project-name')")
    fill('#project-name', 'Browser check project')
    fill('#new-project-notes', 'Initial packaging direction.')
    click_text('Create project')
    browser.wait("document.querySelector('.project-detail-heading h2')?.textContent === 'Browser check project'")
    library_count = browser.evaluate("JSON.parse(localStorage.getItem('chroma-workspace-v2')).library.length")
    comparison_count = browser.evaluate("JSON.parse(localStorage.getItem('chroma-workspace-v2')).comparisons.length")
    fill('#project-notes', 'Compare coated stock against the approved terracotta reference.')
    click_text('Save notes')
    browser.wait("document.querySelector('.project-notes-status')?.textContent.includes('Saved locally')")

    click_text('Add colour')
    browser.wait("document.querySelector('#project-item')")
    colour_id = browser.state()['library'][0]['id']
    fill('#project-item', colour_id)
    click_text('Add to project')
    browser.wait("document.querySelectorAll('.collection-colour').length === 1")
    click_text('Add comparison')
    browser.wait("document.querySelector('#project-item')")
    comparison_id = browser.state()['comparisons'][0]['id']
    fill('#project-item', comparison_id)
    click_text('Add to project')
    browser.wait("document.querySelectorAll('.collection-comparison').length === 1")

    # Notes and canonical project assignments must survive a full app reload.
    browser.evaluate('location.reload()')
    browser.wait("document.querySelector('[aria-label=\"Open Browser check project\"]')")
    browser.click('[aria-label="Open Browser check project"]')
    browser.wait("document.querySelectorAll('.collection-colour').length === 1")
    assert browser.evaluate("document.querySelectorAll('.collection-comparison').length") == 1
    assert browser.evaluate("document.querySelector('#project-notes').value") == 'Compare coated stock against the approved terracotta reference.'

    click_text('Edit project')
    fill('#project-name', 'Renamed browser project')
    click_text('Save changes')
    browser.wait("document.querySelector('.project-detail-heading h2')?.textContent === 'Renamed browser project'")
    browser.click('.collection-colour button[aria-label^="Remove "]')
    browser.wait("document.querySelectorAll('.collection-colour').length === 0")
    browser.click('.collection-comparison button[aria-label^="Remove "]')
    browser.wait("document.querySelectorAll('.collection-comparison').length === 0")
    assert browser.evaluate("JSON.parse(localStorage.getItem('chroma-workspace-v2')).library.length") == library_count
    assert browser.evaluate("JSON.parse(localStorage.getItem('chroma-workspace-v2')).comparisons.length") == comparison_count

    # Assignment removal retains the underlying saved colour in the library.
    browser.evaluate("location.hash = 'library'")
    browser.wait("document.querySelector('[aria-label=\"Search library\"]')")
    fill('[aria-label="Filter by project"]', 'unassigned')
    browser.wait("document.querySelectorAll('.collection-colour').length > 0")
    assert browser.evaluate("document.querySelectorAll('.collection-colour').length") > 0
    fill('[aria-label="Search library"]', 'zzzx-no-such-colour')
    browser.wait("document.querySelectorAll('.collection-colour').length === 0")
    click_text('Reset filters')
    browser.wait("document.querySelectorAll('.collection-colour').length > 0")

    browser.evaluate("location.hash = 'projects'")
    browser.wait("document.querySelector('[aria-label=\"Open Renamed browser project\"]')")
    browser.click('[aria-label="Open Renamed browser project"]')
    click_text('Add colour')
    fill('#project-item', colour_id)
    click_text('Add to project')
    click_text('Add comparison')
    fill('#project-item', comparison_id)
    click_text('Add to project')
    click_text('All projects')
    browser.wait("document.querySelector('[aria-label=\"Delete Renamed browser project\"]')")
    browser.click('[aria-label="Delete Renamed browser project"]')
    click_text('Delete project')
    browser.wait("!document.querySelector('[aria-label=\"Open Renamed browser project\"]')")
    state = browser.evaluate("JSON.parse(localStorage.getItem('chroma-workspace-v2'))")
    assert len(state['library']) == library_count
    assert len(state['comparisons']) == comparison_count
    assert any(c['id'] == colour_id and not c.get('projectId') for c in state['library'])
    assert any(c['id'] == comparison_id and not c.get('projectId') for c in state['comparisons'])
    return {'projects': 'create, notes, reload persistence, rename, assign/remove colours and comparisons, delete while preserving library records', 'library': 'unassigned filter, search, reset'}
