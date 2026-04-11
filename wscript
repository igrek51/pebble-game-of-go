import os.path

top = '.'
out = 'build'

def options(ctx):
    ctx.load('pebble_sdk')

def configure(ctx):
    ctx.load('pebble_sdk')

def build(ctx):
    ctx.load('pebble_sdk')

    # For a pure JS Rocky.js app, we don't compile C.
    # The build system should handle packaging JS and resources.
    
    # If pbl_bundle is still needed for packaging JS, it might be called differently.
    # For now, let's assume pebble build will handle JS packaging directly.
    # If not, we may need to re-add a simplified pbl_bundle call for JS.
    
    # Removed C compilation and binaries setup.
    # Removed old pbl_bundle call related to C binaries.
    pass # Placeholder, may need to be adjusted if pebble build requires more for JS.
