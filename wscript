import os.path

top = '.'
out = 'build'

def options(ctx):
    ctx.load('pebble_sdk')

def configure(ctx):
    ctx.load('pebble_sdk')

def build(ctx):
    ctx.load('pebble_sdk')
    ctx.pbl_bundle(
        rocky=ctx.path.ant_glob('src/rocky/**/*.js'),
        js=ctx.path.ant_glob('src/pkjs/**/*.js')
    )
