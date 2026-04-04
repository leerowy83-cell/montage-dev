from django.urls import path
from . import views

urlpatterns = [
    path("", views.index, name="index"),

    # Setup
    path("api/setup/",       views.db_setup_status, name="db_setup_status"),
    path("api/setup/sql/",   views.db_setup_sql,    name="db_setup_sql"),

    # Files
    path("api/upload/",      views.upload_file,   name="upload_file"),
    path("api/download/",    views.download_file,  name="download_file"),

    # Conversations
    path("api/conversations/",                                    views.list_conversations,   name="list_conversations"),
    path("api/conversations/create/",                             views.create_conversation,  name="create_conversation"),
    path("api/conversations/<uuid:conversation_id>/",             views.update_conversation,  name="update_conversation"),
    path("api/conversations/<uuid:conversation_id>/delete/",      views.delete_conversation,  name="delete_conversation"),
    path("api/conversations/<uuid:conversation_id>/export/",      views.export_conversation,  name="export_conversation"),
    path("api/conversations/<uuid:conversation_id>/claude-md/",   views.get_claude_md,        name="get_claude_md"),
    path("api/conversations/<uuid:conversation_id>/claude-md/set/", views.set_claude_md,      name="set_claude_md"),
    path("api/conversations/<uuid:conversation_id>/todos/",       views.get_todos,            name="get_todos"),

    # Messages
    path("api/conversations/<uuid:conversation_id>/messages/",    views.list_messages,        name="list_messages"),
    path("api/conversations/<uuid:conversation_id>/send/",        views.send_message,         name="send_message"),
    path("api/conversations/<uuid:conversation_id>/regenerate/",  views.regenerate_message,   name="regenerate_message"),
    path("api/conversations/<uuid:conversation_id>/edit/",        views.edit_message,         name="edit_message"),
]
