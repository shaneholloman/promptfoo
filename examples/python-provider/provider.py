from openai import AsyncOpenAI, OpenAI

async_client = AsyncOpenAI()
client = OpenAI()


def call_api(prompt, options, context):
    # Get config values
    # some_option = options.get("config").get("someOption")

    chat_completion = client.chat.completions.create(
        messages=[
            {
                "role": "system",
                "content": "You are a marketer working for a startup called Bananamax.",
            },
            {
                "role": "user",
                "content": prompt,
            },
        ],
        model="gpt-4.1-mini",
    )

    # Extract token usage information from the response
    token_usage = None
    if hasattr(chat_completion, "usage"):
        token_usage = {
            "total": chat_completion.usage.total_tokens,
            "prompt": chat_completion.usage.prompt_tokens,
            "completion": chat_completion.usage.completion_tokens,
        }

    return {
        "output": chat_completion.choices[0].message.content,
        "tokenUsage": token_usage,
        "metadata": {
            "config": options.get("config", {}),
        },
    }


def some_other_function(prompt, options, context):
    return call_api(prompt + "\nWrite in ALL CAPS", options, context)


async def async_provider(prompt, options, context):
    chat_completion = await async_client.chat.completions.create(
        messages=[
            {
                "role": "system",
                "content": "You are a marketer working for a startup called Bananamax.",
            },
            {
                "role": "user",
                "content": prompt,
            },
        ],
        model="gpt-4o",
    )

    # Extract token usage information from the async response
    token_usage = None
    if hasattr(chat_completion, "usage"):
        token_usage = {
            "total": chat_completion.usage.total_tokens,
            "prompt": chat_completion.usage.prompt_tokens,
            "completion": chat_completion.usage.completion_tokens,
        }

    return {
        "output": chat_completion.choices[0].message.content,
        "tokenUsage": token_usage,
    }


if __name__ == "__main__":
    # Example usage showing prompt, options with config, and context with vars
    prompt = "What is the weather in San Francisco?"
    options = {"config": {"optionFromYaml": 123}}
    context = {"vars": {"location": "San Francisco"}}

    print(call_api(prompt, options, context))
